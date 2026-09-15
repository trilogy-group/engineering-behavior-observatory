/**
 * Embedded Harbor control-plane adapter script.
 *
 * This Python program is materialized to a temporary file and executed by
 * `./adapter.ts` against the pinned `harbor` package. It is deliberately
 * narrow: semantic validation, identity resolution, effective-instruction
 * computation and official lock resolution. Trial lifecycle lives in trial-script.ts. It never captures, normalizes,
 * or assesses agent behavior; that authority stays in EBO's TypeScript
 * adapters (MIGRATION_SPEC.md D1/D3).
 */

export const HARBOR_ADAPTER_PROTOCOL_VERSION = 1;

export const HARBOR_ADAPTER_SCRIPT = String.raw`
"""EBO Harbor control-plane adapter (protocol v1).

Invoked as: python ebo_harbor_adapter.py <op> [args...]
Emits exactly one JSON object on stdout. Exit code 0 on success; on failure a
nonzero exit with {"ok": false, "errorKind": ..., "error": ...} when possible.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

PROTOCOL = 1


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def fail(kind, message):
    emit({"ok": False, "errorKind": kind, "error": message})
    raise SystemExit(1)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_task(task_dir: Path, disable_verification: bool):
    from harbor.models.task.task import Task

    return Task(task_dir, disable_verification=disable_verification)


def op_version(args):
    import harbor

    from harbor.models.task.config import TaskConfig

    sample = TaskConfig()
    emit({
        "ok": True,
        "protocol": PROTOCOL,
        "harborVersion": harbor.__version__,
        "defaultTaskSchemaVersion": sample.schema_version,
        "pythonVersion": sys.version.split()[0],
    })


def op_inspect(args):
    try:
        task = load_task(Path(args.task_dir), args.disable_verification)
    except Exception as exc:  # official validation is the authority
        fail("task-invalid", f"{type(exc).__name__}: {exc}")

    config = task.config
    from harbor.models.task.verifier_mode import task_has_any_shared_verifier
    env = config.environment
    steps = [
        {
            "name": step.name,
            "minReward": step.min_reward,
            "verifierTimeoutSec": step.verifier.timeout_sec,
            "agentTimeoutSec": step.agent.timeout_sec,
        }
        for step in (config.steps or [])
    ]
    compose_path = task.paths.environment_dir / "docker-compose.yaml"
    compose_services = None
    if compose_path.exists():
        try:
            doc = _parse_compose_services(compose_path.read_text())
            compose_services = doc
        except Exception:
            compose_services = None
    emit({
        "ok": True,
        "name": task.name,
        "shortName": task.short_name,
        "version": config.task.version if config.task else None,
        "schemaVersion": config.schema_version,
        "hasSteps": task.has_steps,
        "steps": steps,
        "metadataKeys": sorted(config.metadata.keys()),
        "environment": {
            "os": env.os.value,
            "dockerImage": env.docker_image,
            "cpus": env.cpus,
            "memoryMb": env.memory_mb,
            "storageMb": env.storage_mb,
            "gpus": env.gpus,
            "gpuTypes": env.gpu_types,
            "tpu": bool(env.tpu),
            "networkMode": env.network_mode.value,
            "allowInternet": env.allow_internet,
            "mcpServerCount": len(env.mcp_servers),
            "composeServices": compose_services,
            "buildTimeoutSec": env.build_timeout_sec,
            "workdir": env.workdir,
        },
        "verifier": {
            "hasSharedSteps": task.has_steps and task_has_any_shared_verifier(config),
            "timeoutSec": config.verifier.timeout_sec,
            "environmentMode": (
                config.verifier.environment_mode.value
                if config.verifier.environment_mode
                else None
            ),
            "collectCount": len(config.verifier.collect),
        },
        "hasSolution": task.paths.solution_dir.exists(),
        "multiStepRewardStrategy": (
            config.multi_step_reward_strategy.value
            if config.multi_step_reward_strategy is not None
            else None
        ),
        "hasTests": task.paths.tests_dir.exists(),
    })


def _parse_compose_services(text: str):
    import yaml  # harbor ships PyYAML for compose files

    doc = yaml.safe_load(text) or {}
    services = doc.get("services") or {}
    return sorted(services.keys())


def op_identity(args):
    from harbor.publisher.packager import Packager

    task_dir = Path(args.task_dir).resolve()
    try:
        content_hash, files = Packager.compute_content_hash(task_dir)
    except Exception as exc:
        fail("task-invalid", f"{type(exc).__name__}: {exc}")

    included = [p.relative_to(task_dir).as_posix() for p in files]
    included_set = set(included)
    excluded = []
    for p in sorted(task_dir.rglob("*")):
        if p.is_file():
            rel = p.relative_to(task_dir).as_posix()
            if rel not in included_set:
                excluded.append(rel)
    emit({
        "ok": True,
        "digest": content_hash,
        "includedFiles": included,
        "excludedFiles": excluded,
    })


def op_instructions(args):
    from harbor.models.task.task import Task

    try:
        task = Task(
            Path(args.task_dir),
            disable_verification=args.disable_verification,
            extra_instructions=args.extra_instruction or [],
        )
    except Exception as exc:
        fail("task-invalid", f"{type(exc).__name__}: {exc}")

    if task.has_steps:
        instructions = [
            {"step": step.name, "instruction": task.step_instruction(step.name)}
            for step in (task.config.steps or [])
        ]
    else:
        instructions = [{"step": None, "instruction": task.instruction}]
    for entry in instructions:
        entry["sha256"] = sha256_hex(entry["instruction"].encode("utf-8"))
    emit({"ok": True, "instructions": instructions})


def op_lock(args):
    from harbor.models.job.lock import build_trial_lock
    from harbor.models.trial.config import TaskConfig as TrialTaskConfig, TrialConfig

    task_dir = Path(args.task_dir).resolve()
    try:
        trial_config = TrialConfig(task=TrialTaskConfig(path=task_dir))
        lock = build_trial_lock(
            trial_config=trial_config,
            task_download_result=SimpleNamespace(
                path=task_dir, content_hash=None, resolved_git_commit_id=None
            ),
        )
    except Exception as exc:
        fail("task-invalid", f"{type(exc).__name__}: {exc}")
    emit({"ok": True, "taskLock": json.loads(lock.task.model_dump_json()), "trialLock": json.loads(lock.model_dump_json())})


def op_docker_preflight(args):
    if not shutil.which("docker"):
        emit({"ok": True, "available": False, "reason": "docker-cli-missing"})
        return
    try:
        subprocess.run(
            ["docker", "info"], capture_output=True, timeout=15, check=True
        )
    except subprocess.CalledProcessError:
        emit({"ok": True, "available": False, "reason": "docker-daemon-unreachable"})
        return
    except (subprocess.TimeoutExpired, OSError):
        emit({"ok": True, "available": False, "reason": "docker-probe-failed"})
        return
    emit({"ok": True, "available": True, "reason": None})


def main(argv):
    parser = argparse.ArgumentParser(prog="ebo-harbor-adapter")
    sub = parser.add_subparsers(dest="op", required=True)

    p = sub.add_parser("version")
    p.set_defaults(func=op_version)

    p = sub.add_parser("inspect")
    p.add_argument("task_dir")
    p.add_argument("--disable-verification", action="store_true")
    p.set_defaults(func=op_inspect)

    p = sub.add_parser("identity")
    p.add_argument("task_dir")
    p.set_defaults(func=op_identity)

    p = sub.add_parser("instructions")
    p.add_argument("task_dir")
    p.add_argument("--disable-verification", action="store_true")
    p.add_argument("--extra-instruction", action="append")
    p.set_defaults(func=op_instructions)

    p = sub.add_parser("lock")
    p.add_argument("task_dir")
    p.set_defaults(func=op_lock)

    p = sub.add_parser("docker-preflight")
    p.set_defaults(func=op_docker_preflight)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main(sys.argv[1:])
`;
