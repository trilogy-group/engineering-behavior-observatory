import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { digestMetadata } from "../artifacts.js";
import type { AssessmentMode, Digest } from "../contracts.js";
import { inspectTaskPacket } from "../task-packets.js";
import { materializeWorkspace } from "../workspaces.js";
import { inspectHarborTask } from "./tasks.js";
import type { HarborAdapter } from "./adapter.js";

export const HARBOR_CONVERSION_SCHEMA_VERSION = "ebo.harbor-conversion/v1";
export type HarborConversionFieldMapping = {
  source: string; target: string; status: "mapped" | "not-provided" | "unsupported"; note?: string;
};
export type HarborConversionReport = {
  schemaVersion: typeof HARBOR_CONVERSION_SCHEMA_VERSION;
  packetId: string; packetDigest: Digest; assessmentMode: AssessmentMode;
  convertedAt: string; taskDirectory: string; harborDigest: string | null;
  mappings: HarborConversionFieldMapping[]; warnings: string[];
  status: "ready-for-review" | "manual-action-required";
};
export type ConvertLegacyPacketOptions = {
  studyRoot: string; packetLocator: string; freezeLocator?: string;
  destinationRoot?: string; environmentImage?: string; convertedAt?: () => string; adapter?: HarborAdapter;
};
export type HarborConversionOutcome = { report: HarborConversionReport; taskDirectory: string };

/** Reuse the admitted archive materializer; conversion never grants a new admission. */
export async function convertLegacyTaskPacket(options: ConvertLegacyPacketOptions): Promise<HarborConversionOutcome> {
  const inspection = inspectTaskPacket(options.studyRoot, options.packetLocator);
  if (!inspection.packet || !inspection.packetDigest || inspection.errors.length) {
    throw new Error("Invalid legacy packet: " + inspection.errors.map(e => e.message).join("; "));
  }
  const packet = inspection.packet;
  if (options.environmentImage !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(options.environmentImage)) {
    throw new Error("Environment image must be a single Docker image reference.");
  }
  const workspaceParent = await mkdtemp(join(tmpdir(), "ebo-conversion-"));
  const workspace = await materializeWorkspace({
    bundleRoot: options.studyRoot, packetLocator: options.packetLocator, freezeLocator: options.freezeLocator,
    workspaceParent,
  }).catch(async error => { await rm(workspaceParent, { recursive: true, force: true }); throw error; });
  const taskDirectory = join(resolve(options.destinationRoot ?? join(options.studyRoot, "harbor-inbox")), "legacy-" + packet.id);
  let created = false;
  try {
    if (workspace.status !== "ready") throw new Error(workspace.error ?? "Legacy materialization failed.");
    await mkdir(resolve(taskDirectory, ".."), { recursive: true });
    await mkdir(taskDirectory, { mode: 0o700 }); // exclusive: never modify a prior conversion
    created = true;
    await mkdir(join(taskDirectory, "environment"));
    await cp(workspace.path, join(taskDirectory, "environment", "workspace"), { recursive: true, errorOnExist: true, force: false });
    await writeFile(join(taskDirectory, "instruction.md"), packet.agentInput.prompt, { flag: "wx" });
    await writeFile(join(taskDirectory, "task.toml"), 'schema_version = "1.4"\n[environment]\nos = "linux"\n', { flag: "wx" });
    const warnings: string[] = [];
    if (options.environmentImage) {
      await writeFile(join(taskDirectory, "environment", "Dockerfile"), "FROM " + options.environmentImage + "\nWORKDIR /workspace\nCOPY workspace/ /workspace/\n", { flag: "wx" });
      warnings.push("Review the supplied image and required setup; conversion does not infer dependencies.");
    } else warnings.push("Supply environment/Dockerfile with a runtime and COPY workspace/ into its working directory before admission.");
    if (packet.assessmentMode === "verified") warnings.push("Adapt the legacy verifier and optional solution explicitly. No verifier, reward, or approval was synthesized.");
    const mappings: HarborConversionFieldMapping[] = [
      { source: "agentInput.prompt", target: "instruction.md", status: "mapped", note: "Exact text; no newline added." },
      { source: "agentInput.fixture", target: "environment/workspace", status: "mapped", note: "Only admitted archive members, with executable modes." },
      { source: "provenance, admission, sharing, controlledPerturbation", target: "conversion lineage", status: "mapped", note: "Original packet digest retained; new Harbor review required." },
      { source: "restricted", target: "tests/ and solution/", status: packet.assessmentMode === "verified" ? "unsupported" : "not-provided" },
    ];
    const ready = options.environmentImage !== undefined && packet.assessmentMode === "observational";
    const validation = await inspectHarborTask(taskDirectory, { assessmentMode: "observational", adapter: options.adapter });
    if (ready && validation.classification !== "valid") throw new Error("Converted task fails official Harbor validation: " + (validation.reason ?? validation.unsupported.join(", ")));
    const report: HarborConversionReport = {
      schemaVersion: HARBOR_CONVERSION_SCHEMA_VERSION, packetId: packet.id, packetDigest: inspection.packetDigest,
      assessmentMode: packet.assessmentMode, convertedAt: (options.convertedAt ?? (() => new Date().toISOString()))(),
      taskDirectory, harborDigest: validation.identity?.digest ?? null, mappings, warnings,
      status: ready ? "ready-for-review" : "manual-action-required",
    };
    // Outside the task: a report must not change the task digest it records.
    await writeFile(taskDirectory + ".conversion.json", JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { report, taskDirectory };
  } catch (error) {
    if (created) await rm(taskDirectory, { recursive: true, force: true });
    throw error;
  } finally { await workspace.cleanup("success"); await rm(workspaceParent, { recursive: true, force: true }); }
}
export function conversionReportDigest(report: HarborConversionReport): Digest { return digestMetadata(report); }
export async function readHarborConversionReport(taskDirectory: string): Promise<HarborConversionReport> {
  return JSON.parse(await readFile(taskDirectory + ".conversion.json", "utf8")) as HarborConversionReport;
}
