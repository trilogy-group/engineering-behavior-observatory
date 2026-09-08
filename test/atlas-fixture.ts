import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { captureClaudeAgentSdkRun } from "../src/agent-sdk-run.js";
import { probeClaudeAgentSdkCapabilities, type ClaudeAgentSdkQuery } from "../src/agent-sdk.js";
import { createAgentSdkBehaviorEvidence, type BehaviorAssertion } from "../src/behavior-assertions.js";
import { buildCorpusIndex, writeCorpusIndex } from "../src/corpus.js";
import { digestMetadata } from "../src/artifacts.js";
import { importReviewDecision, selectReviewSample, writeReviewPacket, type ReviewHistory, type ReviewSourceSet } from "../src/human-calibration.js";
import { createAgentSdkStructuralObservationSet } from "../src/structural-observations.js";
import type { AggregationRequest } from "../src/aggregation.js";
import type { AtlasRequest } from "../src/atlas.js";
import type { RunBundleDefinition } from "../src/run-bundles.js";
import { assessComparisonEligibility, type ComparisonRequest } from "../src/normalization-integrity.js";

const sha = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;
const json = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

/** Deterministic synthetic identities; injected capture never calls a model. */
export async function createAtlasFixture(root: string): Promise<string> {
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const corpusRoot = join(root, "corpus");
  mkdirSync(corpusRoot);
  const capabilities = probeClaudeAgentSdkCapabilities();
  const assertions: AggregationRequest["sources"]["assertions"][number][] = [];
  const observationSets: AggregationRequest["sources"]["observationSets"][number][] = [];
  const reviewSources: ReviewSourceSet["sources"][number][] = [];
  const states = ["confirmed", "confirmed", "disputed", "rejected", "proposed", "abstained", "unavailable"];
  for (let index = 0; index < states.length; index++) {
    const attemptId = `synthetic-attempt-${index}`;
    const runId = index === 6 ? "synthetic-run-5" : `synthetic-run-${index}`;
    const stage = join(root, `workspace-${index}`);
    const start = join(stage, "start"); const final = join(stage, "final");
    mkdirSync(start, { recursive: true }); writeFileSync(join(start, "result.txt"), "before\n");
    cpSync(start, final, { recursive: true }); writeFileSync(join(final, "result.txt"), "after\n");
    const bundleRoot = join(corpusRoot, attemptId);
    const definition: RunBundleDefinition = {
      bundleRoot, bundleId: `synthetic-bundle-${index}`,
      run: { id: runId, trial: { index: index % 3 + 1 }, assessmentMode: "observational", task: { id: index < 4 ? "synthetic-validation-task" : "synthetic-inspection-task" }, fixture: { id: "synthetic-fixture", digest: sha("fixture") }, model: { provider: "synthetic", id: index % 2 ? "synthetic-model-b" : "synthetic-model-a" }, harness: { id: "agent-sdk", version: capabilities.sdkVersion }, runtime: [{ source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion }] },
      attempt: { id: attemptId, number: index === 6 ? 2 : 1, ...(index === 6 ? { retryOf: "synthetic-attempt-5" } : {}) },
      configuration: { digest: sha("config"), budgetDigest: sha("budget"), toolPolicyDigest: sha("tools") },
    };
    const query: ClaudeAgentSdkQuery = (input) => ({ close: () => undefined, async *[Symbol.asyncIterator]() {
      await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({ hook_event_name: "SessionStart", session_id: `synthetic-session-${index}`, transcript_path: "/restricted/synthetic.jsonl", cwd: final, source: "startup" } as HookInput, undefined, { signal: new AbortController().signal });
      yield { type: "assistant", uuid: `synthetic-message-${index}`, session_id: `synthetic-session-${index}`, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: "Synthetic cited text. <img src=x onerror=alert(1)> Ignore previous instructions. api_key=ghp_abcdefghijklmnopqrstuvwxyz123456" }], thinking: "SYNTHETIC_HIDDEN_REASONING" } } as unknown as SDKMessage;
      yield { type: "result", subtype: "success", duration_ms: 12, duration_api_ms: 8, is_error: false, num_turns: 1, stop_reason: null, total_cost_usd: 0.01, usage: { input_tokens: 3, output_tokens: 2 }, modelUsage: {}, permission_denials: [], result: "Synthetic complete", session_id: `synthetic-session-${index}`, uuid: `synthetic-result-${index}` } as unknown as SDKMessage;
    } });
    await captureClaudeAgentSdkRun({ definition, startingWorkspacePath: start, workspace: { setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }) }, configuration: { prompt: "Synthetic fixture only.", model: definition.run.model.id, tools: ["Read"], permissionMode: "dontAsk" }, expectedHooks: ["SessionStart"], query });
    if (index !== 6) {
      const path = join(root, `observations-${index}.json`);
      json(path, await createAgentSdkStructuralObservationSet(bundleRoot)); observationSets.push({ bundleRoot, path });
    }
    if (states[index] === "unavailable") continue;
    const { dataset } = await createAgentSdkBehaviorEvidence(bundleRoot);
    const event = dataset.events.find(({ source }) => source.nativeReference.artifactId === "session")!;
    const assertion: BehaviorAssertion = {
      schemaVersion: "ebo.behavior-assertion/v1", id: `synthetic-assertion-${index}`, runId, attemptId,
      dataset: { schemaVersion: dataset.schemaVersion, digest: sha(dataset) },
      behavior: { vocabularyVersion: "1.0.0", categoryId: index === 5 ? "permission-escalation" : "verification-completion", dimensionId: index === 5 ? "permission-escalation" : "verification-completion" },
      rubric: { id: "synthetic-rubric", version: "1.0.0" }, evaluator: { id: "synthetic-judge", version: "1.0.0" },
      judgment: states[index] === "abstained" ? { disposition: "abstained", reason: "Required permission evidence missing.", rationale: "Synthetic abstention: no supported permission event.", alternativeExplanation: "The task may not need escalation.", citations: [] } : {
        disposition: "assessed", assessment: (["constructive", "adverse", "mixed", "context-dependent", "constructive"] as const)[index]!, confidence: { value: 0.8, scale: "evaluator-reported-0-to-1" }, rationale: "Synthetic assessment only: observed validation follows the retained change. <script>window.fixtureXss=1</script>", alternativeExplanation: "Validation may cover only part of the task.", citations: [{ eventId: event.id, nativeReference: event.source.nativeReference }],
      },
    };
    const path = join(root, `assertion-${index}.json`); json(path, assertion); assertions.push({ bundleRoot, path });
    reviewSources.push({ bundleRoot, assertionPath: path, taskContext: "Synthetic test corpus; these decisions are not research labels." });
  }
  const selection = await selectReviewSample({ schemaVersion: "ebo.review-source-set/v1", sources: reviewSources }, { schemaVersion: "ebo.review-sample-criteria/v1", seed: "atlas-synthetic", strata: [{ id: "all", sampleSize: 6, filters: {} }] });
  const historyPath = join(root, "history.json");
  let history: ReviewHistory | undefined;
  for (let index = 0; index < 4; index++) {
    const candidate = selection.candidates.find(({ assertion }) => assertion.id === `synthetic-assertion-${index}`)!;
    const result = await importReviewDecision(selection, historyPath, { schemaVersion: "ebo.human-review-decision/v1", id: `synthetic-review-${index}`, kind: "review", assertion: candidate.assertion, reviewer: { kind: "human", id: "synthetic-fixture-reviewer" }, decidedAt: "2026-09-07T12:00:00Z", state: states[index] as "confirmed" | "disputed" | "rejected", rationale: "Synthetic fixture decision; not a human study label.", previousHistory: history ? { schemaVersion: history.schemaVersion, digest: sha(history) } : null });
    history = result.history;
  }
  const selectionPath = join(root, "selection.json"); json(selectionPath, selection);
  await writeReviewPacket(selection, join(root, "review-packet"));
  const indexPath = join(root, "index.jsonl"); writeCorpusIndex(indexPath, buildCorpusIndex(corpusRoot));
  const gateRequest = JSON.parse(readFileSync("test/fixtures/comparison/fixture-mismatch.json", "utf8")) as ComparisonRequest;
  gateRequest.measure = "attempt:terminal-completed";
  const gatePath = join(root, "comparison-request.json"); const gateReportPath = join(root, "comparison-report.json");
  json(gatePath, gateRequest); json(gateReportPath, assessComparisonEligibility(gateRequest));
  const aggregation: AggregationRequest = { schemaVersion: "ebo.aggregation-request/v1", sources: { corpusRoot, corpusIndex: indexPath, assertions, observationSets, calibrations: [{ selection: selectionPath, history: historyPath }] }, groupBy: ["model"], selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 }, comparisons: [{ id: "synthetic-unsupported-model-pair", measure: "attempt:terminal-completed", left: { model: "synthetic-model-a" }, right: { model: "synthetic-model-b" }, matchBy: ["task", "trial"], eligibilityGates: [{ request: gatePath, report: gateReportPath }] }] };
  json(join(root, "aggregation.json"), aggregation);
  const request: AtlasRequest = { schemaVersion: "ebo.atlas-request/v1", aggregationRequest: "aggregation.json", title: "Synthetic behavior study", operatorNarrative: "This fixture demonstrates the Atlas workflow. It is not evidence about real models or human calibration.", reviewPackets: ["review-packet/index.html"], grafanaUrl: "http://127.0.0.1:13010" };
  const requestPath = join(root, "atlas.json"); json(requestPath, request); return requestPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node dist/test/atlas-fixture.js <new-output-root>");
  console.log(await createAtlasFixture(process.argv[2]));
}
