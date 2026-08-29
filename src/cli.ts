#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifact, validateExportManifest, validateRunManifestEvidence } from "./artifacts.js";

const usage = `Usage: ebo [--help] | validate <artifact.json>...

Engineering Behavior Observatory
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
