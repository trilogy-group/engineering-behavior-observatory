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

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = main();
}
