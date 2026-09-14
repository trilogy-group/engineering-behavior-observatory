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
import asyncio, fcntl, json, os
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
before = (task/'task.toml').read_bytes()
record = e.derive_task(task, root/'derived', binding, True)
assert (task/'task.toml').read_bytes() == before
assert record['originalDigest'] != record['derivedDigest']
derived = Task(root/'derived')
assert derived.config.steps[0].min_reward == .5
assert derived.config.multi_step_reward_strategy.value == 'final'
assert derived.config.steps[0].verifier.environment.docker_image == image['image']
assert derived.config.environment.docker_image == image['image']
request = {'ownerRoot': str(root), 'queueDigest': 'q', 'taskPath': str(root/'derived'),
    'attemptId': 'prepare', 'trialsDir': str(root/'trials'), 'model': 'fixture',
    'budgetMs': 30000, 'build': 'test', 'verified': True, 'environmentManifest': manifest}

async def check():
    trial = await e.create_trial(request, prepare=True)
    envs = [env async for env in e.preparation_environments(trial)]
    assert len(envs) == 3
    assert [e.env_identity(env)['role'] for env in envs] == ['agent', 'grader', 'grader']
    agent = envs[0]
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
    assert not e.owner_alive(root)
    agent._network_policy = NetworkPolicy(network_mode=NetworkMode.NO_NETWORK)
    try: e.env_identity(agent)
    except ValueError as exc: assert 'never broadened' in str(exc)
    else: raise AssertionError('Unsupported policy must fail')
asyncio.run(check())
print('Harbor 0.22 model/Smol 1.15 boundary: passed')
`], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /boundary: passed/);
});
