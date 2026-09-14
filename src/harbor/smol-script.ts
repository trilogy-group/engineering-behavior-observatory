/** Pinned provider glue only. Harbor owns steps/verifiers; Smol owns VM operations. */
export const SMOL_SCRIPT = String.raw`
import fcntl
import importlib.metadata
import platform
import shutil
import uuid
from smol import AsyncMachine, MachineConfig, ConnectOptions
from smol.harbor import SmolEnvironment, _checkpoint
from harbor.models.task.task import Task
from harbor.models.task.verifier_mode import resolve_effective_verifier_env_config
from harbor.publisher.packager import Packager
from harbor.environments.factory import EnvironmentFactory

SMOL_VERSION = '1.15.0'
HARBOR_VERSION = '0.22.0'

def json_write(path, value):
    path = Path(path)
    temp = path.with_name('.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as file:
            os.chmod(temp, 0o600)
            json.dump(value, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)

def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

async def boot_identity(machine):
    # SDK read_file assumes ordinary files; procfs reports a synthetic size.
    result = await machine.exec(['cat', '/proc/sys/kernel/random/boot_id'])
    value = result.stdout.strip()
    if result.exit_code or not value: raise ValueError('Cannot read parent boot identity')
    return value

def runtime_provenance(manifest):
    versions = {name: importlib.metadata.version(name) for name in ('smolmachines', 'harbor')}
    if versions != {'smolmachines': SMOL_VERSION, 'harbor': HARBOR_VERSION}:
        raise ValueError('Requires smolmachines==1.15.0 and harbor==0.22.0: ' + str(versions))
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('This patched Smol runtime is qualified only on Apple Silicon macOS')
    library = Path(os.environ.get('SMOLVM_LIB_DIR', '')) / 'libkrun.dylib'
    if not library.is_absolute() or not library.is_file():
        raise ValueError('Set SMOLVM_LIB_DIR to the isolated patched library directory')
    digest = hashlib.sha256(library.read_bytes()).hexdigest()
    if digest != manifest['libkrunSha256']:
        raise ValueError('Patched libkrun digest differs from the frozen environment condition')
    return {**versions, 'libkrunSha256': digest, 'library': str(library),
            'python': platform.python_version(), 'host': platform.node(), 'platform': 'linux/arm64'}

def validate_environment_manifest(manifest):
    if manifest.get('schemaVersion') != 'ebo.smol-environments/v1' or manifest.get('platform') != 'linux/arm64':
        raise ValueError('Expected ebo.smol-environments/v1 for linux/arm64')
    if not isinstance(manifest.get('tasks'), dict) or not manifest['tasks']:
        raise ValueError('Environment manifest needs task image bindings')
    import re
    if not re.fullmatch('[0-9a-f]{64}', manifest.get('libkrunSha256', '')):
        raise ValueError('Missing pinned libkrun digest')
    for binding in manifest['tasks'].values():
        for image in [binding['agent'], *binding.get('graders', {}).values()]:
            if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', image['image']):
                raise ValueError('Use a registry-accessible platform-specific image digest, not a local tag')
            for key in ('recipeDigest', 'baseImageDigest'):
                if not re.fullmatch('[0-9a-f]{64}', image[key]):
                    raise ValueError('Image preparation must record ' + key)

def derive_task(source, target, binding, verified):
    # Materialize only an execution product; never edit an admitted snapshot.
    original = Task(Path(source), disable_verification=not verified)
    config = original.config.model_copy(deep=True)
    graders = []
    for step in config.steps or [None]:
        env = resolve_effective_verifier_env_config(config, step)
        if verified and env is not None:
            key = step.name if step else 'single'
            if key not in binding.get('graders', {}):
                raise ValueError('Missing separate grader image: ' + key)
            graders.append((step, env.model_copy(deep=True), binding['graders'][key]))
    config.environment.docker_image = binding['agent']['image']
    for step, env, image in graders:
        env.docker_image = image['image']
        (step.verifier if step else config.verifier).environment = env
    shutil.copytree(source, target)
    Path(target, 'task.toml').write_text(config.model_dump_toml(), encoding='utf-8')
    derived = Task(Path(target), disable_verification=not verified)
    if original.instruction != derived.instruction or [original.step_instruction(s.name) for s in original.config.steps or []] != [derived.step_instruction(s.name) for s in derived.config.steps or []]:
        raise ValueError('Image binding changed task instructions')
    return {'originalDigest': Packager.compute_content_hash(Path(source))[0],
            'derivedDigest': Packager.compute_content_hash(Path(target))[0], 'images': binding}

def owner_alive(root):
    with Path(root, 'owner.lock').open('r') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False

def env_identity(env):
    # environment_id includes content uploaded by Harbor after branching.
    config = env.task_env_config.model_dump(mode='json')
    if config.get('env'):
        raise ValueError('Host-expanded task environment variables cannot enter a shared parent; use worker credential keys')
    if config.get('gpus') or config.get('tpu') or config.get('mcp_servers'):
        raise ValueError('GPU, TPU and task MCP servers are not qualified for this Smol profile')
    if not config.get('workdir') or config['workdir'] == '/':
        raise ValueError('Declare an absolute non-root environment workdir')
    if env.network_policy.network_mode.value != 'public':
        raise ValueError('This isolated patched runtime currently qualifies public egress only; no-network image import and allowlist networking require separate conformance. Policy is never broadened.')
    role = 'agent' if env.environment_dir.name == 'environment' else 'grader'
    return {'role': role, 'environmentId': env.environment_id, 'configuration': config,
            'runtime': env.ebo_runtime,
            'network': env.network_policy.model_dump(mode='json')}

class OwnedSmolEnvironment(SmolEnvironment):
    def __init__(self, *args, ebo_owner=None, ebo_queue=None, ebo_prepare=False, ebo_events=None, ebo_runtime=None, **kwargs):
        self.ebo_owner, self.ebo_queue = ebo_owner, ebo_queue
        self.ebo_prepare, self.ebo_events = ebo_prepare, ebo_events
        self.ebo_transfer_failed = False
        self.ebo_runtime = ebo_runtime
        super().__init__(*args, target='local', auto_checkpoint=False, fork_batch_window_ms=0, **kwargs)

    def event(self, state, **fields):
        if self.ebo_events:
            with open(self.ebo_events, 'a', encoding='utf-8') as file:
                os.chmod(self.ebo_events, 0o600)
                file.write(json.dumps({'time': time.time(), 'state': state,
                    'environmentId': self.environment_id, **fields}) + '\n')
                file.flush()
        if self.ebo_owner:
            with open(Path(self.ebo_owner, 'children.jsonl'), 'a', encoding='utf-8') as file:
                os.chmod(file.name, 0o600)
                file.write(json.dumps({'state': state, **fields}) + '\n')

    async def start(self, force_build):
        if self.ebo_prepare: raise RuntimeError('Preparation inspection cannot start an attempt')
        if not owner_alive(self.ebo_owner): raise RuntimeError('Smol parent owner is not alive; explicitly prepare again')
        receipt = json.loads(Path(self.ebo_owner, 'receipt.json').read_text())
        if receipt['state'] != 'ready' or receipt['queueDigest'] != self.ebo_queue:
            raise ValueError('Smol preparation is not ready for this queue')
        identity = env_identity(self)
        key = fingerprint(identity)
        parent = receipt['parents'].get(key)
        if parent is None: raise ValueError('Missing exact Smol parent binding; cold fallback is forbidden')
        machine = await AsyncMachine.connect(parent['machine'], ConnectOptions(target='local'))
        if await machine.state() != 'running':
            raise ValueError('Smol parent is not running; stopped parents are not warm preparation')
        # connect() can restart a stopped local machine. A kernel boot identity
        # prevents that cold restart from masquerading as the prepared RAM state.
        if await boot_identity(machine) != parent['bootId']:
            raise ValueError('Smol parent restarted; explicitly prepare a new parent')
        self._checkpoints = {self.environment_id: _checkpoint(parent['checkpoint'])}
        started = time.monotonic()
        self.event('branch-start', parent=parent['machine'], fingerprint=key)
        try:
            await super().start(force_build)
        except BaseException as exc:
            self.event('branch-failed', parent=parent['machine'], error=str(exc),
                       recovery='Drain attempts and restart the preparation owner; never cold-fallback on chain limits')
            raise
        self.event('branch-ready', parent=parent['machine'], child=self._machine.name,
                   durationSeconds=time.monotonic()-started, fingerprint=key)

    async def download_dir(self, source_path, target_path):
        try:
            await super().download_dir(source_path, target_path)
        except BaseException:
            self.ebo_transfer_failed = True
            raise

    async def stop(self, delete):
        child = self._machine.name if self._machine else None
        if self.ebo_transfer_failed and child:
            self.event('cleanup-pending', child=child, reason='Evidence retrieval failed; deletion withheld. SDK process exit may stop this machine; recovery is not guaranteed.')
            return
        try:
            await super().stop(delete)
            self.event('deleted', child=child)
        except BaseException as exc:
            self.event('cleanup-pending', child=child, reason=str(exc))
            raise

async def preparation_environments(trial):
    yield trial.agent_environment
    if trial.config.verifier.disable: return
    for step in trial.task.config.steps or [None]:
        env_config = resolve_effective_verifier_env_config(trial.task.config, step)
        if env_config is None: continue
        plan = trial._network_plan(step)
        env = EnvironmentFactory.create_environment_from_config(
            config=trial.config.environment, environment_dir=trial._verifier_env_build_context(step),
            environment_name=trial.task.short_name, session_id='ebo-prepare-grader',
            trial_paths=trial.paths, task_env_config=env_config,
            network_policy=plan.verifier_env_baseline, phase_network_policies=[plan.verifier_phase])
        trial._validate_separate_verifier_env_policies(env, plan=plan)
        yield env

async def serve_parents(request):
    root = Path(request['ownerRoot'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = request['environmentManifest']
    validate_environment_manifest(manifest)
    provenance = runtime_provenance(manifest)
    with (root / 'owner.lock').open('a+') as owner:
        os.chmod(root / 'owner.lock', 0o600)
        fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (root / 'receipt.json').exists():
            old = json.loads((root / 'receipt.json').read_text())
            if old['state'] != 'retired':
                raise ValueError('Existing preparation is not retired; inspect owned VM IDs before removing its receipt')
        session = uuid.uuid4().hex
        work = root / session
        work.mkdir(mode=0o700)
        receipt = {'state': 'preparing', 'ownerSession': session, 'queueDigest': request['queueDigest'],
                   'runtime': provenance, 'parents': {}, 'startedAt': time.time()}
        json_write(root / 'receipt.json', receipt)
        (root / 'children.jsonl').write_text('')
        os.chmod(root / 'children.jsonl', 0o600)
        machines = []
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM): loop.add_signal_handler(sig, stop.set)
        try:
            for task in request['tasks']:
                target = work / task['id']
                derive_task(task['path'], target, manifest['tasks'][task['id']], task['verified'])
                trial_request = {**request, 'taskPath': str(target), 'attemptId': 'prepare-' + task['id'],
                    'verified': task['verified'], 'trialsDir': str(work / 'trials')}
                trial = await create_trial(trial_request, prepare=True)
                async for env in preparation_environments(trial):
                    identity = env_identity(env)
                    key = fingerprint(identity)
                    if key in receipt['parents']: continue
                    if stop.is_set(): raise RuntimeError('Preparation interrupted')
                    # No candidate or warm-up command. Preserve the image's startup behavior.
                    start = time.monotonic()
                    machine = await AsyncMachine.create(MachineConfig(
                        name='ebo-parent-' + session[:8] + '-' + key[:10],
                        image=env.task_env_config.docker_image, branchable=True, persistent=True,
                        resources=env._resource_spec(), workdir=env.task_env_config.workdir,
                        ready_timeout_seconds=90), ConnectOptions(target='local'))
                    machines.append(machine)
                    if identity['role'] == 'agent':
                        marker = await machine.read_file('/opt/ebo/runtime.sha256')
                        if marker.decode().strip() != manifest['runtimeArchiveDigest']:
                            raise ValueError('Prepared image has the wrong /opt/ebo runtime pack')
                    checkpoint = {'machine': machine.name, 'resources': {
                        'cpus': env._effective_cpus, 'memory_mb': env._effective_memory_mb,
                        'storage_mb': env._effective_storage_mb, 'gpus': env._effective_gpus},
                        'network_mode': env.network_policy.network_mode.value,
                        'allowed_hosts': list(env.network_policy.allowed_hosts)}
                    checkpoint['resources'] = {k: v for k, v in checkpoint['resources'].items() if v is not None}
                    boot_id = await boot_identity(machine)
                    receipt['parents'][key] = {'machine': machine.name, 'checkpoint': checkpoint, 'bootId': boot_id,
                        'identity': identity, 'preparationSeconds': time.monotonic()-start}
                    json_write(root / 'receipt.json', receipt)
            receipt['state'] = 'ready'
            json_write(root / 'receipt.json', receipt)
            print(json.dumps({'state': 'ready', 'receipt': str(root / 'receipt.json'), 'parents': len(machines)}), flush=True)
            await stop.wait()
        finally:
            receipt['state'] = 'draining'
            json_write(root / 'receipt.json', receipt)
            # Shared OS locks cover whole trials, including verifier/retrieval/cleanup.
            with (root / 'borrowers.lock').open('a+') as borrowers:
                deadline = time.monotonic() + 60
                drained = False
                while time.monotonic() < deadline:
                    try:
                        fcntl.flock(borrowers, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        drained = True
                        break
                    except BlockingIOError:
                        await asyncio.sleep(.2)
                errors = []
                children = {}
                for line in (root / 'children.jsonl').read_text().splitlines():
                    event = json.loads(line)
                    if event.get('child'): children[event['child']] = event['state']
                retained = [child for child, state in children.items() if state != 'deleted']
                if retained: errors.append({'error': 'Children need recovery before parent cleanup', 'children': retained})
                if drained and not retained:
                    for machine in reversed(machines):
                        try: await machine.delete()
                        except Exception as exc: errors.append({'machine': machine.name, 'error': str(exc)})
                elif not drained: errors.append({'error': 'Active trials did not drain; parents retained for operator cleanup'})
                receipt.update(state='cleanup-pending' if errors else 'retired', cleanupErrors=errors, stoppedAt=time.time())
                json_write(root / 'receipt.json', receipt)
`;
