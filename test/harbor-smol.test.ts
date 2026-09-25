import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { HARBOR_TRIAL_SCRIPT } from "../src/harbor/trial-script.js";

const python = process.env.EBO_HARBOR_PYTHON;
test("Smol binding uses official Harbor models and rejects unsupported policies without a VM", { skip: !python }, () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-smol-contract-"));
  writeFileSync(join(root, "ebo_runtime.py"), HARBOR_TRIAL_SCRIPT);
  const result = spawnSync(python!, ["-c", String.raw`
import asyncio, fcntl, hashlib, json, os, smol
from pathlib import Path
from unittest.mock import patch, AsyncMock
from types import SimpleNamespace
import ebo_runtime as e
from harbor.models.task.task import Task
from harbor.models.task.config import EnvironmentConfig, NetworkPolicy, NetworkMode
from harbor.models.trial.paths import TrialPaths

root = Path.cwd()
task = root / 'source'
(task/'environment').mkdir(parents=True)
(task/'environment'/'Dockerfile').write_text('FROM alpine:3.22\n')
(task/'instruction.md').write_text('Common instruction.')
(task/'task.toml').write_text('''schema_version = "1.4"
multi_step_reward_strategy = "final"
[environment]
workdir = "/workspace"
cpus = 1
memory_mb = 512
[verifier]
environment_mode = "separate"
[[steps]]
name = "one"
min_reward = 0.5
[[steps]]
name = "two"
''')
for name in ('one', 'two'):
    path = task/'steps'/name
    (path/'tests').mkdir(parents=True)
    (path/'instruction.md').write_text('Instruction '+name)
    (path/'tests'/'test.sh').write_text('echo 1 > /logs/verifier/reward.txt')
image = {'image': 'registry.example/test@sha256:'+'a'*64, 'recipeDigest': 'b'*64, 'baseImageDigest': 'c'*64}
binding = {'agent': image, 'graders': {'one': image, 'two': image}}
manifest = {'schemaVersion': 'ebo.smol-environments/v1', 'platform': 'linux/arm64',
    'libkrunSha256': 'd'*64, 'runtimeArchiveDigest': 'e'*64, 'tasks': {'task': binding}}
e.validate_environment_manifest(manifest)
bundled = Path(smol.__file__).resolve().parent / 'libkrun.dylib'
manifest['libkrunSha256'] = hashlib.sha256(bundled.read_bytes()).hexdigest()
assert e.runtime_provenance(manifest)['libkrunSha256'] == manifest['libkrunSha256']
with patch.dict(os.environ, {'SMOLVM_LIB_DIR': str(root)}):
    try: e.runtime_provenance(manifest)
    except ValueError as exc: assert 'bundled libkrun' in str(exc)
    else: raise AssertionError('An isolated library override must be rejected')
before = (task/'task.toml').read_bytes()
record = e.derive_task(task, root/'derived', binding, True)
assert (task/'task.toml').read_bytes() == before
assert record['originalDigest'] != record['derivedDigest']
derived = Task(root/'derived')
assert derived.config.steps[0].min_reward == .5
assert derived.config.multi_step_reward_strategy.value == 'final'
assert derived.config.steps[0].verifier.environment.docker_image == image['image']
assert derived.config.environment.docker_image == image['image']
request = {'ownerRoot': str(root), 'queueDigest': 'q', 'taskPath': str(root/'derived'), 'taskSourceId': 'task',
    'attemptId': 'prepare', 'trialsDir': str(root/'trials'), 'model': 'fixture',
    'budgetMs': 30000, 'build': 'test', 'verified': True, 'environmentManifest': manifest}

async def check():
    runner = object.__new__(e.EboAgent)
    runner.index = 0
    runner.deadline = e.time.monotonic() + 60
    runner.request = {'workerInput': {'prepared': {'steps': [{'index': 1}], 'task': {}, 'evidence': {}}},
        'runtime': {'node': 'node', 'entrypoint': 'worker.js', 'environmentKeys': []}, 'nativeRoot': str(root/'native')}
    async def execute(command, **kwargs):
        if command.startswith('/opt/ebo/node'):
            assert kwargs['env']['TMPDIR'] == '/var/tmp/ebo-scratch'
            assert '/var/tmp/ebo-evidence/1/input.json' in command
        return SimpleNamespace(return_code=0, stdout='/workspace' if command == 'pwd' else '', stderr='')
    async def download(source, target):
        assert source == '/var/tmp/ebo-evidence/1'
        (target/'worker-finished.json').write_text(json.dumps({'terminal': {'state': 'completed'}, 'bundleLocator': 'bundle/manifest.json'}))
    environment = SimpleNamespace(exec=AsyncMock(side_effect=execute), upload_file=AsyncMock(), download_dir=AsyncMock(side_effect=download))
    await runner.run('fixture', environment, SimpleNamespace())
    assert environment.exec.await_count >= 3
    history = []
    operation = AsyncMock(side_effect=[RuntimeError('still alive'), None])
    with patch.object(e.asyncio, 'sleep', new_callable=AsyncMock):
        await e.cleanup_owned('owned', operation, history.append)
    assert operation.await_count == 2
    assert [event['state'] for event in history] == ['failed', 'deleted']
    history = []
    operation = AsyncMock(side_effect=RuntimeError('still alive'))
    with patch.object(e.asyncio, 'sleep', new_callable=AsyncMock):
        try: await e.cleanup_owned('owned', operation, history.append)
        except RuntimeError: pass
        else: raise AssertionError('Cleanup exhaustion must remain an error')
    assert operation.await_count == 3 and len(history) == 3
    trial = await e.create_trial(request, prepare=True)
    envs = [env async for env, image_binding in e.preparation_environments(trial, binding)]
    assert len(envs) == 3
    assert [e.env_identity(env)['role'] for env in envs] == ['agent', 'grader', 'grader']
    assert [e.env_identity(env)['context'] for env in envs] == ['environment', 'steps/one/tests', 'steps/two/tests']
    agent = envs[0]
    assert len('harbor-' + agent.session_id + '-' + 'f'*8) <= 63
    with patch.object(e.SmolEnvironment, 'download_dir', new_callable=AsyncMock) as download:
        await agent.download_dir(source_dir='/remote', target_dir=root)
        download.assert_awaited_once_with('/remote', root)
    grader = envs[1]
    with patch.object(grader, 'upload_dir', new_callable=AsyncMock) as upload:
        await grader._upload_environment_dir_after_start()
        upload.assert_awaited_once_with(grader.environment_dir, '/tests')
    with patch.object(e.SmolEnvironment, '_upload_environment_dir_after_start', new_callable=AsyncMock) as upload:
        agent.ebo_context_prepared = True
        await agent._upload_environment_dir_after_start()
        upload.assert_not_called()
        agent.ebo_context_prepared = False
        await agent._upload_environment_dir_after_start()
        upload.assert_awaited_once()
    context = agent.environment_dir
    (context/'setup.sh').write_text('cp private.txt /workspace/private.txt\n')
    (context/'private.txt').write_text('local-only fixture')
    machine = SimpleNamespace(exec=AsyncMock(return_value=SimpleNamespace(exit_code=0, stdout='prepared', stderr='')))
    setup_record = root/'setup-result.json'
    with patch.object(agent, 'upload_dir', new_callable=AsyncMock) as upload:
        await e.prepare_local_context(agent, machine, {**image, 'localSetup':'setup.sh'}, setup_record, 30)
        upload.assert_awaited_once_with(context.resolve(), '/tmp/ebo-parent-setup')
        assert machine.exec.await_args_list[0].args[1].env is None
        assert json.loads(setup_record.read_text())['exitCode'] == 0
        assert agent._machine is None
        machine.exec.return_value.exit_code = 7
        try: await e.prepare_local_context(agent, machine, {**image, 'localSetup':'setup.sh'}, setup_record, 30)
        except RuntimeError as exc: assert 'setup failed' in str(exc)
        else: raise AssertionError('Failed setup must not produce a parent')
        assert json.loads(setup_record.read_text())['exitCode'] == 7
        assert agent._machine is None
        (context/'escape.sh').symlink_to(root/'ebo_runtime.py')
        try: await e.prepare_local_context(agent, machine, {**image, 'localSetup':'escape.sh'}, setup_record, 30)
        except ValueError as exc: assert 'escapes' in str(exc)
        else: raise AssertionError('Setup must stay inside the admitted context')
        (context/'escape.sh').unlink()
    for invalid in ('../setup.sh', '/tmp/setup.sh', ''):
        bad = {**manifest, 'tasks': {'task': {'agent': {**image, 'localSetup': invalid}}}}
        try: e.validate_environment_manifest(bad)
        except ValueError: pass
        else: raise AssertionError('Invalid setup path accepted')
    try: await agent.start(False)
    except RuntimeError as exc: assert 'inspection' in str(exc)
    else: raise AssertionError('Preparation must not execute')
    agent.ebo_prepare = False
    e.json_write(root/'receipt.json', {'state':'ready','queueDigest':'q','parents':{}})
    with (root/'owner.lock').open('w') as owner:
        fcntl.flock(owner, fcntl.LOCK_EX)
        assert e.owner_alive(root)
        with patch.object(e.SmolEnvironment, 'start', new_callable=AsyncMock) as start:
            try: await agent.start(False)
            except ValueError as exc: assert 'Missing exact' in str(exc)
            else: raise AssertionError('Missing mapping must not cold-start')
            start.assert_not_called()
        key = e.fingerprint(e.env_identity(agent))
        parent = {'machine': 'owned-parent', 'bootId': 'boot-one', 'checkpoint': {'machine': 'owned-parent',
            'resources': {'cpus': 1, 'memory_mb': 512}, 'network_mode': 'public'}}
        e.json_write(root/'receipt.json', {'state':'ready','queueDigest':'q','parents':{key:parent}})
        state = AsyncMock(return_value='stopped')
        boot = AsyncMock(return_value=SimpleNamespace(exit_code=0, stdout='boot-one'))
        with patch.object(e.AsyncMachine, 'connect', new_callable=AsyncMock, return_value=SimpleNamespace(state=state, exec=boot)):
            with patch.object(e.SmolEnvironment, 'start', new_callable=AsyncMock) as start:
                try: await agent.start(False)
                except ValueError as exc: assert 'not running' in str(exc)
                else: raise AssertionError('Stopped parent must not be reused')
                start.assert_not_called()
            state.return_value = 'running'
            boot.return_value = SimpleNamespace(exit_code=0, stdout='boot-two')
            with patch.object(e.SmolEnvironment, 'start', new_callable=AsyncMock) as start:
                try: await agent.start(False)
                except ValueError as exc: assert 'restarted' in str(exc)
                else: raise AssertionError('Restarted parent must not be reused')
                start.assert_not_called()
            boot.return_value = SimpleNamespace(exit_code=0, stdout='boot-one')
            async def branch(instance, force):
                assert instance._resolve_checkpoint().machine == 'owned-parent'
                instance._machine = SimpleNamespace(name='owned-child')
            with patch.object(e.SmolEnvironment, 'start', branch):
                await agent.start(False)
            agent.ebo_transfer_failed = True
            with patch.object(e.SmolEnvironment, 'stop', new_callable=AsyncMock) as stop:
                await agent.stop(True)
                stop.assert_not_called()
        events = [json.loads(line) for line in (root/'children.jsonl').read_text().splitlines()]
        assert events[-1]['state'] == 'cleanup-pending'
        assert events[-1]['child'] == 'owned-child'
        agent.ebo_transfer_failed = False
        with patch.object(e.SmolEnvironment, 'stop', new_callable=AsyncMock) as stop, patch.object(e.asyncio, 'sleep', new_callable=AsyncMock):
            stop.side_effect = [RuntimeError('still alive'), None]
            await agent.stop(True)
            assert stop.await_count == 2
        events = [json.loads(line) for line in (root/'children.jsonl').read_text().splitlines()]
        assert events[-1]['state'] == 'deleted'
        assert events[-3]['cleanup']['state'] == 'failed'
        assert events[-2]['cleanup']['state'] == 'deleted'
    assert not e.owner_alive(root)
    agent._network_policy = NetworkPolicy(network_mode=NetworkMode.NO_NETWORK)
    try: e.env_identity(agent)
    except ValueError as exc: assert 'never broadened' in str(exc)
    else: raise AssertionError('Unsupported policy must fail')
asyncio.run(check())
print(f'Harbor {e.HARBOR_VERSION} model/Smol {e.SMOL_VERSION} boundary: passed')
`], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /boundary: passed/);
});

test("local Smol preparation stays private and both branches inherit an unchanged parent", {
  skip: !python || process.env.EBO_SMOL_LOCAL_SETUP_TEST !== "1", timeout: 240_000,
}, () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-smol-local-setup-"));
  writeFileSync(join(root, "ebo_runtime.py"), HARBOR_TRIAL_SCRIPT);
  const result = spawnSync(python!, ["-c", String.raw`
import asyncio, json, uuid
from pathlib import Path
import ebo_runtime as e
from smol import ResourceSpec
from harbor.models.task.config import EnvironmentConfig, NetworkPolicy, NetworkMode
from harbor.models.trial.paths import TrialPaths

async def check():
    root = Path.cwd()
    context = root/'environment'
    context.mkdir()
    (context/'private.txt').write_text('private-' + uuid.uuid4().hex)
    (context/'setup.sh').write_text('mkdir -p /workspace; cp private.txt /workspace/private.txt\n')
    paths = TrialPaths(root/'trial')
    paths.mkdir()
    env = e.SmolEnvironment(environment_dir=context, environment_name='local-preparation',
        session_id='check', trial_paths=paths, task_env_config=EnvironmentConfig(
            docker_image='alpine:3.22', workdir='/tmp', cpus=1, memory_mb=512),
        network_policy=NetworkPolicy(network_mode=NetworkMode.PUBLIC), target='local', auto_checkpoint=False)
    parent = await e.AsyncMachine.create(e.MachineConfig(name='ebo-private-setup-'+uuid.uuid4().hex[:10],
        image='alpine:3.22', branchable=True, workdir='/tmp',
        resources=ResourceSpec(cpus=1, memory_mb=512, storage_gb=1, network=True)), e.ConnectOptions(target='local'))
    try:
        await e.prepare_local_context(env, parent, {'localSetup':'setup.sh'}, root/'setup.json', 30)
        original = (context/'private.txt').read_text()
        for index in range(2):
            child = await parent.branch(parent.name+'-'+str(index))
            try:
                assert (await child.read_file('/workspace/private.txt')).decode() == original
                assert (await child.exec(['sh','-c','test ! -e /tmp/ebo-parent-setup'])).exit_code == 0
                await child.write_file('/workspace/private.txt', b'child mutation')
            finally: await child.delete()
        assert (await parent.read_file('/workspace/private.txt')).decode() == original
        print('Local preparation: two isolated branches, unchanged parent, no task publication')
    finally: await parent.delete()
asyncio.run(check())
`], { cwd: root, encoding: "utf8", timeout: 230_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /two isolated branches/);
});
