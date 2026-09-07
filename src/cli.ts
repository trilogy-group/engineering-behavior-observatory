#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { assertNoDuplicateJsonKeys, canonicalizeMetadata, validateArtifact, validateExportManifest, validateRunManifestEvidence, writeMetadataAtomically } from "./artifacts.js";
import {
  buildCorpusIndex,
  packPortableExport,
  queryCorpusIndex,
  readCorpusIndex,
  unpackPortableExport,
  validateCorpusIndex,
  writeCorpusIndex,
  type CorpusIndexQuery,
} from "./corpus.js";
import { runAgentSdkQueueEntry } from "./agent-sdk-runner.js";
import { runCodexQueueEntry } from "./codex-run.js";
import { createPortableRunBundleExport, type PortableExportPolicy } from "./exports.js";
import { assessComparisonEligibility, type ComparisonRequest } from "./normalization-integrity.js";
import { createAgentSdkStructuralObservationSet } from "./structural-observations.js";
import {
  admitTaskPacket,
  formatErrors,
  freezeTaskPacket,
  inspectTaskPacket,
  statusTaskPacket,
} from "./task-packets.js";
import {
  compileRunQueue,
  inspectRunQueue,
  readBoundedFile,
  readRunQueue,
  validateRunQueue,
  writeRunQueue,
} from "./scheduler.js";

const usage = `Usage: ebo [--help] | validate <artifact.json>... | task-packet <command> ...
       ebo matrix compile <experiment.json> <bundle-root> <queue.json> [--freeze-locator <task-id>=<path>]
       ebo queue inspect <queue.json>
       ebo queue validate <queue.json> [experiment.json] [--bundle-root <bundle-root>]
       ebo agent-sdk run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
       ebo codex run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]
       ebo export create <run-bundle-root> <policy.json> <export-root>
       ebo corpus build <corpus-root> <index.jsonl>
       ebo corpus query <index.jsonl> [--kind|--run|--attempt|--task|--model|--harness|--assessment-mode|--terminal|--failure-class|--verifier-status|--capture|--export-status|--sharing-class <value>]
       ebo corpus validate <corpus-root> <index.jsonl>
       ebo corpus pack <export-root> <policy.json> <archive.tar.gz>
       ebo corpus unpack <archive.tar.gz> <destination-root>
       ebo comparison check <request.json>
       ebo observations create <run-bundle-root> <output.json>
       ebo observations corpus <corpus-root> <index.jsonl> <output-root> [corpus query flags]

Engineering Behavior Observatory
`;
const taskPacketUsage = `Usage: ebo task-packet <validate|admit|freeze|status> <bundle-root> <packet.json> [freeze-record.json]
`;

export function main(
  args = process.argv.slice(2),
  write: (message: string) => void = (message) => {
    process.stdout.write(message);
  },
): number | Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    write(usage);
    return 0;
  }

  if (args[0] === "task-packet") {
    return runTaskPacketCommand(args.slice(1), write);
  }

  if ((args[0] === "matrix" && args[1] === "compile") || args[0] === "compile") {
    return compileQueue(args[0] === "matrix" ? args.slice(2) : args.slice(1), write);
  }

  if (args[0] === "queue" && args[1] === "inspect") {
    if (args[2] === undefined) {
      write("Usage: ebo queue inspect <queue.json>\n");
      return 1;
    }
    try {
      const inspection = inspectRunQueue(readRunQueue(args[2]));
      write(`Run queue ${args[2]}: ${inspection.entryCount} entr${inspection.entryCount === 1 ? "y" : "ies"}; seed=${inspection.seed}; strategy=${inspection.strategy}.\n`);
      return 0;
    } catch (error) {
      write(`${errorMessage(error)}\n`);
      return 1;
    }
  }

  if (args[0] === "queue" && args[1] === "validate") {
    return validateQueue(args.slice(2), write);
  }

  if (args[0] === "agent-sdk" && args[1] === "run") {
    return runAgentSdkCommand(args.slice(2), write);
  }

  if (args[0] === "codex" && args[1] === "run") {
    return runCodexCommand(args.slice(2), write);
  }

  if (args[0] === "export" && args[1] === "create") {
    return createExportCommand(args.slice(2), write);
  }

  if (args[0] === "corpus") {
    return runCorpusCommand(args.slice(1), write);
  }

  if (args[0] === "comparison" && args[1] === "check") {
    if (args[2] === undefined || args.length !== 3) {
      write("Usage: ebo comparison check <request.json>\n");
      return 1;
    }
    try {
      const report = assessComparisonEligibility(readJson(args[2]) as ComparisonRequest);
      write(`${canonicalizeMetadata(report)}\n`);
      return report.status === "unsupported" ? 1 : 0;
    } catch (error) {
      write(`${errorMessage(error)}\n`);
      return 1;
    }
  }

  if (args[0] === "observations") {
    return runObservationsCommand(args.slice(1), write);
  }

  if (args[0] === "validate") {
    if (args.length === 1) {
      write("Usage: ebo validate <artifact.json>...\n");
      return 1;
    }

    const artifacts = args.slice(1).map((artifact) => {
      try {
        return { artifact, document: readJson(artifact) };
      } catch (error) {
        return {
          artifact,
          error: { artifact, schemaVersion: "unknown", field: "/", message: error instanceof Error ? error.message : "Unable to read artifact." },
        };
      }
    });
    const errors = artifacts.flatMap(({ artifact, document, error }) => {
      if (error !== undefined) return [error];
      if (document !== undefined && typeof document === "object" && document !== null
          && (document as { schemaVersion?: unknown }).schemaVersion === "ebo.run-queue/v1") {
        return validateRunQueue(document, undefined, artifact);
      }
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
      const containingEntry = artifacts.find(({ document: candidate }) => candidate !== undefined && typeof candidate === "object" && candidate !== null
        && (candidate as { schemaVersion?: unknown }).schemaVersion === "run-manifest/v1"
        && (candidate as { bundleId?: unknown }).bundleId === bundleId);
      errors.push(...validateExportManifest(
        artifact,
        document,
        containingEntry?.document,
        containingEntry === undefined ? undefined : dirname(containingEntry.artifact),
      ));
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

function runCorpusCommand(args: string[], write: (message: string) => void): number | Promise<number> {
  const [command, first, second, third] = args;
  try {
    if (command === "build" && first !== undefined && second !== undefined && args.length === 3) {
      const entries = buildCorpusIndex(first);
      writeCorpusIndex(second, entries);
      write(`Built ${entries.length} corpus index entr${entries.length === 1 ? "y" : "ies"}.\n`);
      return 0;
    }
    if (command === "query" && first !== undefined) {
      const query = parseCorpusQuery(args.slice(2));
      for (const entry of queryCorpusIndex(readCorpusIndex(first), query)) write(`${canonicalizeMetadata(entry)}\n`);
      return 0;
    }
    if (command === "validate" && first !== undefined && second !== undefined && args.length === 3) {
      const issues = validateCorpusIndex(first, readCorpusIndex(second));
      for (const issue of issues) write(`${issue.manifestPath} [${issue.kind}]: ${issue.message}\n`);
      if (issues.length > 0) return 1;
      write("Corpus index is current and all indexed evidence is reachable.\n");
      return 0;
    }
    if (command === "pack" && first !== undefined && second !== undefined && third !== undefined && args.length === 4) {
      return packPortableExport(first, third, readJson(second) as PortableExportPolicy).then((digest) => {
        write(`Packed portable export (${digest}).\n`);
        return 0;
      }, (error: unknown) => {
        write(`${errorMessage(error)}\n`);
        return 1;
      });
    }
    if (command === "unpack" && first !== undefined && second !== undefined && args.length === 3) {
      const manifest = unpackPortableExport(first, second);
      write(`Unpacked portable export ${manifest.bundleId} (${manifest.artifacts.length} artifacts).\n`);
      return 0;
    }
  } catch (error) {
    write(`${errorMessage(error)}\n`);
    return 1;
  }
  write("Usage: ebo corpus <build|query|validate|pack|unpack> ...\n");
  return 1;
}

function parseCorpusQuery(args: string[]): CorpusIndexQuery {
  const fields: Record<string, keyof CorpusIndexQuery> = {
    "--kind": "manifestKind",
    "--run": "runId",
    "--trial": "runId",
    "--attempt": "attemptId",
    "--task": "taskId",
    "--model": "modelId",
    "--harness": "harnessId",
    "--assessment-mode": "assessmentMode",
    "--terminal": "terminalState",
    "--failure-class": "failureClass",
    "--verifier-status": "verifierStatus",
    "--capture": "captureQualification",
    "--export-status": "exportStatus",
    "--sharing-class": "sharingClass",
  };
  const query: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const field = fields[args[index]!];
    const value = args[index + 1];
    if (field === undefined || value === undefined) throw new Error("Corpus query filters require a supported flag and value.");
    query[field] = value;
  }
  return query as CorpusIndexQuery;
}

async function runObservationsCommand(args: string[], write: (message: string) => void): Promise<number> {
  const [command, first, second, third] = args;
  try {
    if (command === "create" && first !== undefined && second !== undefined && args.length === 3) {
      assertDerivedDestination(first, second);
      const report = await createAgentSdkStructuralObservationSet(first);
      await writeObservationReport(second, report, first);
      write(`Created ${report.observations.length} structural observations for attempt ${report.attemptId}.\n`);
      return 0;
    }
    if (command === "corpus" && first !== undefined && second !== undefined && third !== undefined) {
      assertDerivedDestination(first, third);
      const index = readCorpusIndex(second);
      const issues = validateCorpusIndex(first, index);
      if (issues.length > 0) throw new Error(`Corpus index is not current: ${issues[0]!.manifestPath} ${issues[0]!.message}`);
      const selected = queryCorpusIndex(index, { ...parseCorpusQuery(args.slice(4)), manifestKind: "run" });
      if (selected.length === 0) throw new Error("Corpus selection matched no retained run bundles.");
      const outputRoot = resolve(third);
      const outputParent = realpathSync(dirname(outputRoot));
      assertOutside(realpathSync(first), outputParent);
      if (existsSync(outputRoot)) throw new Error("Structural observation corpus destination already exists.");
      const stagingRoot = mkdtempSync(join(outputParent, ".ebo-observations-"));
      let published = false;
      try {
        for (const entry of selected) {
          if (entry.runId === undefined || entry.attemptId === undefined || entry.issues.length > 0) throw new Error(`Corpus entry ${entry.manifestPath} is not observation-ready.`);
          const bundleRoot = dirname(join(resolve(first), ...entry.manifestPath.split("/")));
          const report = await createAgentSdkStructuralObservationSet(bundleRoot);
          await writeObservationReport(join(stagingRoot, observationFileName(entry.runId, entry.attemptId)), report, first);
        }
        renameSync(stagingRoot, outputRoot);
        published = true;
      } finally {
        if (!published) rmSync(stagingRoot, { recursive: true, force: true });
      }
      write(`Created structural observations for ${selected.length} corpus run bundle(s).\n`);
      return 0;
    }
  } catch (error) {
    write(`${errorMessage(error)}\n`);
    return 1;
  }
  write("Usage: ebo observations <create|corpus> ...\n");
  return 1;
}

async function writeObservationReport(path: string, report: unknown, sourceRoot: string): Promise<void> {
  const destination = resolve(path);
  assertOutside(realpathSync(sourceRoot), realpathSync(dirname(destination)));
  await writeMetadataAtomically(dirname(destination), basename(destination), report, undefined, { overwrite: false });
}

function assertDerivedDestination(sourceRoot: string, destination: string): void {
  const source = resolve(sourceRoot);
  const output = resolve(destination);
  assertOutside(source, output);
}

function assertOutside(source: string, output: string): void {
  const locator = relative(source, output);
  if (locator === "" || locator !== ".." && !locator.startsWith(`..${sep}`)) {
    throw new Error("Structural observations must be written outside immutable source evidence.");
  }
}

function observationFileName(runId: string, attemptId: string): string {
  return `sha256-${createHash("sha256").update(JSON.stringify([runId, attemptId])).digest("hex")}.json`;
}

async function runAgentSdkCommand(
  args: string[],
  write: (message: string) => void,
): Promise<number> {
  const agentSdkRunUsage = "Usage: ebo agent-sdk run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]\n";
  const positional: string[] = [];
  let workspaceRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--workspace-root") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) {
        write(agentSdkRunUsage);
        return 1;
      }
      workspaceRoot = value;
    } else positional.push(args[index]!);
  }
  const [bundleRoot, queuePath, runId, outputRoot] = positional;
  if (bundleRoot === undefined || queuePath === undefined || runId === undefined
      || outputRoot === undefined || positional.length !== 4) {
    write(agentSdkRunUsage);
    return 1;
  }
  try {
    const summary = await runAgentSdkQueueEntry({
      bundleRoot,
      queuePath,
      runId,
      outputRoot,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
    write(`${canonicalizeMetadata(summary)}\n`);
    return 0;
  } catch (error) {
    write(`${errorMessage(error)}\n`);
    return 1;
  }
}

async function runCodexCommand(
  args: string[],
  write: (message: string) => void,
): Promise<number> {
  const commandUsage = "Usage: ebo codex run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>]\n";
  const positional: string[] = [];
  let workspaceRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--workspace-root") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) {
        write(commandUsage);
        return 1;
      }
      workspaceRoot = value;
    } else positional.push(args[index]!);
  }
  const [bundleRoot, queuePath, runId, outputRoot] = positional;
  if (bundleRoot === undefined || queuePath === undefined || runId === undefined
      || outputRoot === undefined || positional.length !== 4) {
    write(commandUsage);
    return 1;
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const summary = await runCodexQueueEntry({
      bundleRoot,
      queuePath,
      runId,
      outputRoot,
      signal: controller.signal,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
    write(`${canonicalizeMetadata(summary)}\n`);
    return 0;
  } catch (error) {
    write(`${errorMessage(error)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function createExportCommand(
  args: string[],
  write: (message: string) => void,
): Promise<number> {
  const [sourceRoot, policyPath, exportRoot] = args;
  if (sourceRoot === undefined || policyPath === undefined || exportRoot === undefined || args.length !== 3) {
    write("Usage: ebo export create <run-bundle-root> <policy.json> <export-root>\n");
    return 1;
  }
  try {
    const manifest = await createPortableRunBundleExport({
      sourceRoot,
      destinationRoot: exportRoot,
      policy: readJson(policyPath) as PortableExportPolicy,
    });
    write(`Created ${manifest.sharingClass} portable export (${manifest.status}) for bundle ${manifest.bundleId} at ${exportRoot}.\n`);
    return 0;
  } catch (error) {
    write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function compileQueue(
  args: string[],
  write: (message: string) => void,
): number {
  const positional: string[] = [];
  let bundleRoot: string | undefined;
  let outputPath: string | undefined;
  const freezeLocators: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--bundle-root") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) {
        write("Usage: ebo matrix compile <experiment.json> <bundle-root> <queue.json> [--freeze-locator <task-id>=<path>]\n");
        return 1;
      }
      bundleRoot = value;
    } else if (argument === "--output") {
      outputPath = args[++index];
    } else if (argument === "--freeze-locator") {
      const value = args[++index];
      const separator = value?.indexOf("=") ?? -1;
      if (separator <= 0 || separator === value!.length - 1) {
        write("Usage: ebo matrix compile <experiment.json> <bundle-root> <queue.json> [--freeze-locator <task-id>=<path>]\n");
        return 1;
      }
      freezeLocators[value!.slice(0, separator)] = value!.slice(separator + 1);
    } else {
      positional.push(argument);
    }
  }
  const experimentPath = positional.shift();
  if (experimentPath === undefined) {
    write("Usage: ebo matrix compile <experiment.json> <bundle-root> <queue.json> [--freeze-locator <task-id>=<path>]\n");
    return 1;
  }
  if (bundleRoot === undefined && positional.length === 2) bundleRoot = positional.shift();
  if (outputPath === undefined && positional.length === 1) outputPath = positional.shift();
  if (bundleRoot === undefined) bundleRoot = dirname(experimentPath);
  if (outputPath === undefined) {
    write("Usage: ebo matrix compile <experiment.json> <bundle-root> <queue.json> [--freeze-locator <task-id>=<path>]\n");
    return 1;
  }

  try {
    const experiment = readJson(experimentPath);
    const queue = compileRunQueue(experiment as Parameters<typeof compileRunQueue>[0], {
      bundleRoot,
      ...(Object.keys(freezeLocators).length === 0 ? {} : { freezeLocators }),
    });
    writeRunQueue(outputPath, queue);
    write(`Compiled ${queue.entries.length} run entr${queue.entries.length === 1 ? "y" : "ies"} into ${outputPath}. Seed: ${queue.seed}.\n`);
    return 0;
  } catch (error) {
    write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function validateQueue(
  args: string[],
  write: (message: string) => void,
): number {
  const positional: string[] = [];
  let bundleRoot: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--bundle-root") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) {
        write("Usage: ebo queue validate <queue.json> [experiment.json] [--bundle-root <bundle-root>]\n");
        return 1;
      }
      bundleRoot = value;
    } else positional.push(args[index]!);
  }
  const queuePath = positional[0];
  if (queuePath === undefined || positional.length > 2) {
    write("Usage: ebo queue validate <queue.json> [experiment.json] [--bundle-root <bundle-root>]\n");
    return 1;
  }
  try {
    const experiment = positional[1] === undefined ? undefined : readJson(positional[1]);
    const queue = readRunQueue(
      queuePath,
      experiment as Parameters<typeof compileRunQueue>[0] | undefined,
      bundleRoot === undefined ? {} : { bundleRoot },
    );
    const entryCount = queue.entries.length;
    write(`Validated run queue ${queuePath} (${entryCount} entr${entryCount === 1 ? "y" : "ies"}).\n`);
    return 0;
  } catch (error) {
    write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function readJson(path: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(path));
  assertNoDuplicateJsonKeys(text);
  return JSON.parse(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to process run queue.";
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
  Promise.resolve(main()).then((exitCode) => {
    process.exitCode = exitCode;
  }, (error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
