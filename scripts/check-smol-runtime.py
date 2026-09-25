"""Opt-in, no-model Smol/Harbor compatibility gate. Creates only owned local VMs.

Install harbor==0.22.0 and smolmachines[harbor]==1.18.2.
Run with that isolated interpreter; an optional argv[1] selects an OCI
image (prefer a digest for recorded conformance). --direct removes Harbor and
the OCI workload from the execution path. No Docker daemon or cloud is used.
"""
import asyncio
import importlib.metadata
import json
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from smol import ConnectOptions, Machine, MachineConfig, ResourceSpec
from smol.harbor import SmolEnvironment
from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy
from harbor.models.trial.paths import TrialPaths


async def borrower(parent, image, label):
    with tempfile.TemporaryDirectory(prefix="ebo-smol-borrower-") as directory:
        root = Path(directory)
        environment = root / "environment"
        environment.mkdir()
        paths = TrialPaths(root / "trial")
        paths.mkdir()
        env = SmolEnvironment(
            environment_dir=environment, environment_name="ebo-smol-proof",
            session_id=label, trial_paths=paths,
            task_env_config=EnvironmentConfig(docker_image=image, cpus=1,
                memory_mb=512, storage_mb=1024, workdir="/tmp"),
            network_policy=NetworkPolicy(network_mode=NetworkMode.PUBLIC),
            target="local", auto_checkpoint=False, fork_batch_window_ms=0,
        )
        # Contract-test this single pinned provider member before execution.
        from smol.harbor import _checkpoint
        env._checkpoints[env.environment_id] = _checkpoint({
            "machine": parent, "resources": {"cpus": 1, "memory_mb": 512, "storage_mb": 1024},
            "network_mode": "public",
        })
        assert env._resolve_checkpoint().machine == parent
        try:
            await env.start(force_build=False)
            result = await env.exec("test ! -e /tmp/ebo-child && printf child > /tmp/ebo-child")
            assert result.return_code == 0, result
            await env.download_file("/tmp/ebo-child", root / "retained.txt")
            assert (root / "retained.txt").read_text() == "child"
            print(json.dumps({"borrower": label, "branch": env._machine.name, "retained": True}), flush=True)
        finally:
            await env.stop(delete=True)


def main():
    assert importlib.metadata.version("smolmachines") == "1.18.2"
    assert importlib.metadata.version("harbor") == "0.22.0"
    if sys.argv[1:2] == ["--borrower"]:
        asyncio.run(borrower(*sys.argv[2:]))
        return
    if sys.argv[1:2] == ["--direct"]:
        name = "ebo-smol-direct-" + uuid.uuid4().hex[:12]
        parent = Machine.create(MachineConfig(name=name, branchable=True,
            resources=ResourceSpec(cpus=1, memory_mb=512)), ConnectOptions(target="local"))
        try:
            print(json.dumps({"stage": "parent-ready", "name": parent.name}), flush=True)
            with parent.branch(name + "-child") as child:
                result = child.exec(["/bin/sh", "-c", "printf smol-direct-ok"])
                assert result.exit_code == 0 and result.stdout == "smol-direct-ok", result
        finally:
            parent.delete()
            print(json.dumps({"stage": "parent-deleted", "name": name}), flush=True)
        return
    image = sys.argv[1] if len(sys.argv) > 1 else "alpine:3.22"
    name = "ebo-smol-conformance-" + uuid.uuid4().hex[:12]
    print(json.dumps({"stage": "creating-parent", "name": name, "image": image}), flush=True)
    parent = Machine.create(MachineConfig(name=name, image=image, branchable=True,
        resources=ResourceSpec(cpus=1, memory_mb=512, storage_gb=1, network=True),
        workdir="/tmp", ready_timeout_seconds=90), ConnectOptions(target="local"))
    try:
        print(json.dumps({"stage": "parent-ready", "name": parent.name}), flush=True)
        for label in ["first", "second"]:
            subprocess.run([sys.executable, __file__, "--borrower", parent.name, image, label],
                           check=True, timeout=120)
        result = parent.exec(["/bin/sh", "-c", "test ! -e /tmp/ebo-child"])
        assert result.exit_code == 0, result
        print(json.dumps({"compatibility": "passed", "borrowers": 2, "parentUnchanged": True}), flush=True)
    finally:
        parent.delete()
        print(json.dumps({"stage": "parent-deleted", "name": name}), flush=True)


if __name__ == "__main__":
    main()
