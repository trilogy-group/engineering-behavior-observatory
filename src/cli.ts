#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const usage = `Usage: ebo [--help]

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
