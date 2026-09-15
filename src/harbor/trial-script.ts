import { SMOL_SCRIPT } from "./smol-script.js";
/** Harbor owns the trial. Smol owns VMs; this extension executes the native TS worker. */
export const HARBOR_TRIAL_SCRIPT = String.raw`
import asyncio
import contextlib
import hashlib
import json
import os
import shlex
import signal
import sys
import tempfile
import time
from pathlib import Path
from harbor.agents.base import BaseAgent
from harbor.models.trial.config import TrialConfig
from harbor.trial.trial import Trial

${SMOL_SCRIPT}

class EboAgent(BaseAgent):
    def __init__(self, *args, ebo_request=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.request = ebo_request if isinstance(ebo_request, dict) else json.loads(Path(ebo_request).read_text())
        self.index = 0
        self.deadline = time.monotonic() + self.request['budgetMs'] / 1000

    @staticmethod
    def name(): return 'ebo-native'
    def version(self): return self.request['build']

    async def setup(self, environment):
        self.environment = environment
        runtime = self.request['runtime']
        result = await environment.exec('cat /opt/ebo/runtime.sha256')
        if result.return_code or result.stdout.strip() != runtime['archiveDigest']:
            raise ValueError('Image does not contain the selected /opt/ebo runtime pack')
        for item in self.request['configurationFiles']:
            parent = str(Path('/tmp/ebo-worker/config/' + item['locator']).parent)
            result = await environment.exec('mkdir -p ' + shlex.quote(parent))
            if result.return_code: raise RuntimeError('Worker configuration directory creation failed')
            await environment.upload_file(Path(item['hostPath']), '/tmp/ebo-worker/config/' + item['locator'])

    async def run(self, instruction, environment, context):
        self.index += 1
        workdir = (await environment.exec('pwd')).stdout.strip()
        if not workdir or workdir == '/': raise ValueError('Harbor task must declare a working directory distinct from /')
        root = '/var/tmp/ebo-evidence/' + str(self.index)
        scratch = '/var/tmp/ebo-scratch'
        created = await environment.exec('mkdir -p ' + shlex.quote(root) + ' ' + shlex.quote(scratch))
        if created.return_code: raise RuntimeError('Cannot prepare disk-backed worker evidence and scratch directories')
        payload = json.loads(json.dumps(self.request['workerInput']))
        prepared = payload['prepared']
        # Deliver only this step. Future instructions and verifier gates stay on
        # the host with Harbor, not in a candidate-readable worker input file.
        step = next(s for s in prepared['steps'] if s['index'] == self.index)
        step.update(minReward=None, verifierTimeoutSec=0)
        prepared['steps'] = [step]
        prepared['task']['snapshotDirectory'] = ''
        prepared['verifier'] = {'requested': False, 'environmentMode': None, 'timeoutSec': 0, 'multiStepRewardStrategy': 'mean'}
        prepared['evidence'] = {key: root for key in prepared['evidence']}
        payload.update(instruction=instruction, stepIndex=self.index, workspacePath=workdir,
                       outputRoot=root, maxWallClockMs=max(1, int((self.deadline-time.monotonic())*1000)))
        with tempfile.TemporaryDirectory(prefix='ebo-worker-input-') as temp:
            source = Path(temp) / 'input.json'
            source.write_text(json.dumps(payload))
            source.chmod(0o600)
            await environment.upload_file(source, root + '/input.json')
        runtime = self.request['runtime']
        argv = ['/opt/ebo/' + runtime['node'], '/opt/ebo/' + runtime['entrypoint'], root + '/input.json']
        env = {key: os.environ[key] for key in runtime['environmentKeys'] if key in os.environ}
        # Smol mounts /tmp as tmpfs. Repository copies and Git indexes need disk.
        env['TMPDIR'] = scratch
        # Expose only the explicitly selected credential/route keys, not the host environment.
        command = ' '.join(shlex.quote(v) for v in argv)
        try:
            result = await environment.exec(command, env=env)
            target = Path(self.request['nativeRoot']) / str(self.index)
            target.mkdir(parents=True, exist_ok=True)
            (target / 'worker-stdio.json').write_text(json.dumps({'stdout': result.stdout, 'stderr': result.stderr, 'returnCode': result.return_code}))
            if result.return_code: raise RuntimeError('EBO native worker failed; inspect retained step evidence')
        finally:
            # A canceled Smol exec may leave the Node process running. Bound its drain
            # before Harbor destroys the environment; never start a replacement attempt.
            stop = 'if test -f {r}/worker.pid && ! test -f {r}/worker-finished.json; then p=$(cat {r}/worker.pid); case "$p" in *[!0-9]*|"") exit 1;; esac; kill -TERM "$p" 2>/dev/null || true; for i in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done; kill -KILL "$p" 2>/dev/null || true; fi'.format(r=shlex.quote(root))
            try: await asyncio.wait_for(environment.exec(stop), timeout=15)
            finally:
                target = Path(self.request['nativeRoot']) / str(self.index)
                target.mkdir(parents=True, exist_ok=True)
                await environment.download_dir(root, target)
        result_path = Path(self.request['nativeRoot']) / str(self.index) / 'worker-finished.json'
        result = json.loads(result_path.read_text())
        context.metadata = {'ebo_step': self.index, 'ebo_native_bundle': result.get('bundleLocator')}
        if result['terminal']['state'] != 'completed':
            raise RuntimeError('EBO native terminal: ' + result['terminal']['state'])

async def create_trial(request, prepare=False, request_path=None):
    module = Path(__file__).stem
    config = TrialConfig.model_validate({
        'task': {'path': request['taskPath']},
        'trial_name': request['attemptId'], 'trials_dir': request['trialsDir'],
        'agent': {'import_path': module + ':EboAgent', 'model_name': request['model'],
                  'kwargs': {'ebo_request': request if prepare else request_path}, 'resume_trajectory': False},
        'environment': {'import_path': module + ':OwnedSmolEnvironment', 'delete': True,
            'kwargs': {'ebo_owner': request['ownerRoot'], 'ebo_queue': request['queueDigest'],
                'ebo_prepare': prepare, 'ebo_events': request.get('smolEvents'),
                'ebo_runtime': {'smol': SMOL_VERSION, 'harbor': HARBOR_VERSION,
                    'build': request['build'], 'libkrun': request['environmentManifest']['libkrunSha256'],
                    'taskSourceId': request['taskSourceId'],
                    'pack': request['environmentManifest']['runtimeArchiveDigest'],
                    'preparation': fingerprint(request['environmentManifest'])}}},
        'verifier': {'disable': not request['verified']},
    })
    return await Trial.create(config)

async def main(request_path):
    request = json.loads(Path(request_path).read_text())
    if request.get('operation') == 'serve':
        await serve_parents(request)
        return {'state': 'stopped'}
    validate_environment_manifest(request['environmentManifest'])
    provenance = runtime_provenance(request['environmentManifest'])
    root = Path(request['ownerRoot'])
    # Acquire before rechecking the owner. Shutdown excludes new borrowers.
    with (root / 'borrowers.lock').open('a+') as lease:
        os.chmod(root / 'borrowers.lock', 0o600)
        fcntl.flock(lease, fcntl.LOCK_SH)
        if not owner_alive(root): raise RuntimeError('Start ebo harbor environment serve before running attempts')
        receipt = json.loads((root / 'receipt.json').read_text())
        if receipt['state'] != 'ready' or receipt['queueDigest'] != request['queueDigest'] or receipt['runtime'] != provenance:
            raise ValueError('Preparation binding/runtime changed or owner is draining')
        json_write(Path(request_path).parent / 'preparation.json', receipt)
        target = Path(request_path).parent / 'execution-task'
        request['taskSourceId'] = request['workerInput']['prepared']['task']['taskSourceId']
        transformation = derive_task(request['taskPath'], target,
            request['environmentManifest']['tasks'][request['workerInput']['prepared']['task']['taskSourceId']], request['verified'])
        request['taskPath'] = str(target)
        json_write(Path(request_path).parent / 'task-transformation.json', transformation)
        trial = await create_trial(request, request_path=request_path)
        return await execute_trial(trial, request)

async def execute_trial(trial, request):
    loop = asyncio.get_running_loop()
    current = asyncio.current_task()
    for sig in (signal.SIGTERM, signal.SIGINT): loop.add_signal_handler(sig, current.cancel)
    try:
        async with asyncio.timeout(request['budgetMs'] / 1000):
            result = await trial.run()
        return result.model_dump(mode='json')
    except (asyncio.CancelledError, TimeoutError):
        return trial.result.model_dump(mode='json')

if __name__ == '__main__':
    # Harbor diagnostics go to stderr; stdout is one final control response.
    try:
        request = json.loads(Path(sys.argv[1]).read_text())
        if request.get('operation') == 'serve':
            result = asyncio.run(main(sys.argv[1]))
        else:
            with contextlib.redirect_stdout(sys.stderr): result = asyncio.run(main(sys.argv[1]))
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({'exception_info': {'exception_type': type(exc).__name__, 'exception_message': str(exc)}}))
        sys.exit(1)
`;
