#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifact, validateExportManifest, validateRunManifestEvidence } from "./artifacts.js";
import {
  admitTaskPacket,
  formatErrors,
  freezeTaskPacket,
  inspectTaskPacket,
  statusTaskPacket,
} from "./task-packets.js";

const usage = `Usage: ebo [--help] | validate <artifact.json>... | task-packet <command> ...

Engineering Behavior Observatory
`;
const taskPacketUsage = `Usage: ebo task-packet <validate|admit|freeze|status> <bundle-root> <packet.json> [freeze-record.json]
`;

export function main(
  args = process.argv.slice(2),
  write: (message: string) => void = (message) => {
    process.stdout.write(message);
  },
): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    write(usage);
    return 0;
  }

  if (args[0] === "task-packet") {
    return runTaskPacketCommand(args.slice(1), write);
  }

  if (args[0] === "validate") {
    if (args.length === 1) {
      write("Usage: ebo validate <artifact.json>...\n");
      return 1;
    }

    const artifacts = args.slice(1).map((artifact) => {
      try {
        return { artifact, document: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(artifact))) };
      } catch (error) {
        return {
          artifact,
          error: { artifact, schemaVersion: "unknown", field: "/", message: error instanceof Error ? error.message : "Unable to read artifact." },
        };
      }
    });
    const errors = artifacts.flatMap(({ artifact, document, error }) => {
      if (error !== undefined) return [error];
      const validation = validateArtifact(artifact, document);
      return document !== undefined && typeof document === "object" && document !== null
        && (document as { schemaVersion?: unknown }).schemaVersion === "run-manifest/v1"
        ? [...validation, ...validateRunManifestEvidence(artifact, document, dirname(artifact))]
        : validation;
    });
    for (const { artifact, document } of artifacts) {
      if (document === undefined || typeof document !== "object" || document === null
          || (document as { schemaVersion?: unknown }).schemaVersion !== "export-manifest/v1") continue;
      const bundleId = (document as { bundleId?: unknown }).bundleId;
      const containing = artifacts.find(({ document: candidate }) => candidate !== undefined && typeof candidate === "object" && candidate !== null
        && (candidate as { schemaVersion?: unknown }).schemaVersion === "run-manifest/v1"
        && (candidate as { bundleId?: unknown }).bundleId === bundleId)?.document;
      errors.push(...validateExportManifest(artifact, document, containing));
    }

    if (errors.length === 0) {
      write(`Validated ${args.length - 1} artifact(s).\n`);
      return 0;
    }
    for (const error of errors) {
      write(`${error.artifact} [${error.schemaVersion}] ${error.field}: ${error.message}\n`);
    }
    return 1;
  }

  process.stderr.write(`Unknown argument: ${args[0]}\n`);
  return 1;
}

function runTaskPacketCommand(
  args: string[],
  write: (message: string) => void,
): number {
  const [command, bundleRoot, packetLocator, freezeLocator] = args;
  if (command === undefined || bundleRoot === undefined || packetLocator === undefined
      || !["validate", "admit", "freeze", "status"].includes(command)) {
    write(taskPacketUsage);
    return 1;
  }

  try {
    if (command === "validate") {
      const inspection = inspectTaskPacket(bundleRoot, packetLocator);
      if (inspection.errors.length > 0) {
        write(`${formatErrors(inspection.errors)}\n`);
        return 1;
      }
      write(`Validated task packet "${inspection.packet!.id}".\n`);
      return 0;
    }

    if (command === "admit") {
      const inspection = admitTaskPacket(bundleRoot, packetLocator);
      if (inspection.errors.length > 0) {
        write(`${formatErrors(inspection.errors)}\n`);
        return 1;
      }
      write(`Admitted task packet "${inspection.packet!.id}".\n`);
      return 0;
    }

    if (command === "freeze") {
      const record = freezeTaskPacket(bundleRoot, packetLocator, freezeLocator);
      write(`Frozen task packet "${record.packetId}" (aggregate ${record.aggregateDigest.algorithm}:${record.aggregateDigest.value}).\n`);
      return 0;
    }

    const status = statusTaskPacket(bundleRoot, packetLocator, freezeLocator);
    write(`Task packet status: ${status.status}\n`);
    if (status.packetId !== null) write(`Packet: ${status.packetId}\n`);
    if (status.packetDigest !== null) write(`Packet digest: ${status.packetDigest.algorithm}:${status.packetDigest.value}\n`);
    if (status.aggregateDigest !== null) write(`Aggregate digest: ${status.aggregateDigest.algorithm}:${status.aggregateDigest.value}\n`);
    for (const mismatch of status.mismatches) write(`Mismatch: ${mismatch}\n`);
    if (status.errors.length > 0) write(`${formatErrors(status.errors)}\n`);
    return status.status === "frozen" ? 0 : 1;
  } catch (error) {
    write(`${error instanceof Error ? error.message : "Task packet command failed."}\n`);
    return 1;
  }
}

function isDirectExecution(entryPath = process.argv[1]): boolean {
  if (entryPath === undefined) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  process.exitCode = main();
}
