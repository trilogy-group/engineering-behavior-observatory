import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  createAgentSdkBehaviorEvidence,
  validateBehaviorAssertion,
  validateBehaviorReview,
  type BehaviorAssertion,
  type BehaviorReview,
  type AgentSdkBehaviorEvidence,
} from "./behavior-assertions.js";
import {
  assertNoDuplicateJsonKeys,
  canonicalizeMetadata,
  digestMetadata,
  validateArtifact,
  validateRunManifestEvidence,
  writeMetadataAtomically,
} from "./artifacts.js";
import { readBoundedFile } from "./scheduler.js";
import type { RunManifest } from "./run-bundles.js";

type DigestString = `sha256:${string}`;
type Outcome = "passed" | "failed" | "not-run" | "error" | "unavailable";
type DecisionState = Exclude<BehaviorReview["state"], "proposed">;

export type ReviewSourceSet = {
  schemaVersion: "ebo.review-source-set/v1";
  sources: ReadonlyArray<{ bundleRoot: string; assertionPath: string; taskContext: string }>;
};

export type ReviewFilters = {
  taskIds?: readonly string[];
  modelIds?: readonly string[];
  harnessIds?: readonly string[];
  outcomes?: readonly Outcome[];
  terminalStates?: readonly string[];
  categoryIds?: readonly string[];
  abstentions?: readonly boolean[];
  confidence?: { min?: number; max?: number };
};

export type ReviewSampleCriteria = {
  schemaVersion: "ebo.review-sample-criteria/v1";
  seed: string;
  strata: ReadonlyArray<{ id: string; sampleSize: number; filters: ReviewFilters }>;
};

export type ReviewCandidate = {
  assertion: { id: string; schemaVersion: "ebo.behavior-assertion/v1"; digest: DigestString };
  source: { bundleRoot: string; assertionPath: string };
  context: {
    runId: string;
    attemptId: string;
    taskId: string;
    taskContext: string;
    modelId: string;
    harnessId: string;
    terminalState: string;
    outcome: Outcome;
    categoryId: string;
    abstained: boolean;
    confidence: number | null;
  };
};

export type ReviewSample = {
  schemaVersion: "ebo.review-sample/v1";
  createdAt: string;
  criteria: ReviewSampleCriteria;
  population: {
    sourceCount: number;
    eligibleAssertionIds: readonly string[];
    selectedAssertionIds: readonly string[];
    unavailableStrata: readonly string[];
    strata: ReadonlyArray<{ id: string; eligible: number; selected: number; requested: number }>;
  };
  candidates: readonly ReviewCandidate[];
};

export type ReviewDecision = {
  schemaVersion: "ebo.human-review-decision/v1";
  id: string;
  kind: "review" | "adjudication";
  assertion: ReviewCandidate["assertion"];
  reviewer: { kind: "human"; id: string };
  decidedAt: string;
  state: DecisionState;
  rationale: string;
  previousHistory: null | { schemaVersion: "ebo.review-history/v1"; digest: DigestString };
  adjudicates?: readonly string[];
};

export type ReviewHistory = {
  schemaVersion: "ebo.review-history/v1";
  selection: { schemaVersion: "ebo.review-sample/v1"; digest: DigestString };
  decisions: readonly ReviewDecision[];
};

type Agreement =
  | { status: "unavailable"; denominator: 0; population: string; reason: string }
  | { status: "available"; denominator: number; population: string; agreements: number; disagreements: number; rate: number };

export type CalibrationSummary = {
  schemaVersion: "ebo.calibration-summary/v1";
  selection: { schemaVersion: "ebo.review-sample/v1"; digest: DigestString };
  history: { schemaVersion: "ebo.review-history/v1"; digest: DigestString };
  totals: CalibrationCounts;
  categories: ReadonlyArray<{ categoryId: string; counts: CalibrationCounts }>;
};

type CalibrationCounts = {
  selectedAssertions: number;
  judgeAbstentions: number;
  humanDecisionAbstentions: number;
  disputedAssertions: number;
  unresolvedAssertions: number;
  confirmedEligibleAssertions: number;
  rejectedAssertions: number;
  judgeHumanAgreement: Agreement;
  humanHumanAgreement: Agreement;
  adjudication: { denominator: number; population: "human adjudication decisions"; confirmed: number; rejected: number; unresolved: number };
};

type LoadedCandidate = ReviewCandidate & {
  assertionDocument: BehaviorAssertion;
  manifest: RunManifest;
  capture: AgentSdkBehaviorEvidence["capture"];
};

export async function selectReviewSample(
  sourceSet: ReviewSourceSet,
  criteria: ReviewSampleCriteria,
  now: () => string = () => new Date().toISOString(),
): Promise<ReviewSample> {
  assertValid("review source set", sourceSet);
  assertValid("review sample criteria", criteria);
  if (new Set(criteria.strata.map(({ id }) => id)).size !== criteria.strata.length) {
    throw new Error("Review sample stratum IDs must be unique.");
  }
  for (const { id, filters } of criteria.strata) {
    if (filters.confidence?.min !== undefined && filters.confidence.max !== undefined
        && filters.confidence.min > filters.confidence.max) {
      throw new Error(`Review sample stratum "${id}" has an inverted confidence range.`);
    }
  }
  const loaded = await Promise.all(sourceSet.sources.map(loadCandidate));
  const identities = loaded.map(({ assertion }) => assertionKey(assertion));
  if (new Set(identities).size !== identities.length) throw new Error("Review source assertion identities must be unique.");

  const assignments = new Map<string, string>();
  for (const candidate of loaded) {
    const matches = criteria.strata.filter(({ filters }) => matchesFilters(candidate, filters));
    if (matches.length > 1) throw new Error(`Review assertion "${candidate.assertion.id}" matches more than one stratum.`);
    if (matches[0] !== undefined) assignments.set(assertionKey(candidate.assertion), matches[0].id);
  }

  const candidates: ReviewCandidate[] = [];
  const strata = criteria.strata.map((stratum) => {
    const eligible = loaded.filter(({ assertion }) => assignments.get(assertionKey(assertion)) === stratum.id)
      .sort((left, right) => seededKey(criteria.seed, stratum.id, left.assertion).localeCompare(
        seededKey(criteria.seed, stratum.id, right.assertion),
      ));
    candidates.push(...eligible.slice(0, stratum.sampleSize).map(publicCandidate));
    return { id: stratum.id, eligible: eligible.length, selected: Math.min(eligible.length, stratum.sampleSize), requested: stratum.sampleSize };
  });
  const sample: ReviewSample = {
    schemaVersion: "ebo.review-sample/v1",
    createdAt: now(),
    criteria: structuredClone(criteria),
    population: {
      sourceCount: loaded.length,
      eligibleAssertionIds: loaded.filter(({ assertion }) => assignments.has(assertionKey(assertion))).map(({ assertion }) => assertion.id).sort(),
      selectedAssertionIds: candidates.map(({ assertion }) => assertion.id),
      unavailableStrata: strata.filter(({ eligible }) => eligible === 0).map(({ id }) => id),
      strata,
    },
    candidates,
  };
  assertValid("review sample", sample);
  return sample;
}

export async function writeReviewPacket(selection: ReviewSample, outputRoot: string, now = () => new Date().toISOString()): Promise<void> {
  assertValid("review sample", selection);
  const root = resolve(outputRoot);
  assertCalibrationDestination(selection.candidates.map(({ source }) => source.bundleRoot), root);
  if (existsSync(root)) throw new Error("Review packet destination already exists.");
  const loaded = await Promise.all(selection.candidates.map(reloadCandidate));
  for (const candidate of loaded) {
    if (candidate.assertion.digest !== digest(candidate.assertionDocument)) {
      throw new Error(`Review assertion "${candidate.assertion.id}" changed after sample selection.`);
    }
  }
  mkdirSync(root, { recursive: false, mode: 0o700 });
  const packet = {
    schemaVersion: "ebo.review-packet/v1" as const,
    createdAt: now(),
    selection: { schemaVersion: selection.schemaVersion, digest: digest(selection) },
    evidenceBoundary: {
      classification: "restricted-local-only" as const,
      copiedNativeEvidence: true as const,
      note: "Only cited native records are copied into this restricted local packet; links retain the source bundle path. This is not a partner or public export.",
    },
    items: loaded.map((candidate) => packetItem(root, candidate)),
  };
  assertValid("review packet", packet);
  writeFileSync(join(root, "packet.json"), `${canonicalizeMetadata(packet)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  mkdirSync(join(root, "evidence"), { mode: 0o700 });
  for (const item of packet.items) {
    for (const citation of item.citations) {
      writeFileSync(join(root, citation.href), renderEvidenceHtml(citation), { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  }
  writeFileSync(join(root, "index.html"), renderPacketHtml(packet), { encoding: "utf8", mode: 0o600, flag: "wx" });
}

export async function importReviewDecision(
  selection: ReviewSample,
  historyPath: string,
  decision: ReviewDecision,
): Promise<{ appended: boolean; history: ReviewHistory }> {
  assertValid("review sample", selection);
  assertValid("human review decision", decision);
  assertCalibrationDestination(selection.candidates.map(({ source }) => source.bundleRoot), historyPath);
  const selectionBinding = { schemaVersion: selection.schemaVersion, digest: digest(selection) } as const;
  const existing = existsSync(historyPath) ? readJson(historyPath) as ReviewHistory : {
    schemaVersion: "ebo.review-history/v1" as const,
    selection: selectionBinding,
    decisions: [],
  };
  validateReviewHistory(selection, existing);
  const duplicate = existing.decisions.find(({ id }) => id === decision.id);
  if (duplicate !== undefined) {
    if (canonicalizeMetadata(duplicate) !== canonicalizeMetadata(decision)) {
      throw new Error(`Review decision "${decision.id}" conflicts with an existing decision.`);
    }
    return { appended: false, history: existing };
  }
  const matchingId = selection.candidates.filter(({ assertion }) => assertion.id === decision.assertion.id);
  if (matchingId.length === 0) throw new Error(`Review decision targets unknown assertion "${decision.assertion.id}".`);
  const candidate = matchingId.find(({ assertion }) => assertionKey(assertion) === assertionKey(decision.assertion));
  if (candidate === undefined) throw new Error("Review decision assertion binding is stale.");
  const loaded = await reloadCandidate(candidate);
  if (canonicalizeMetadata(decision.assertion) !== canonicalizeMetadata(loaded.assertion)) {
    throw new Error("Review decision assertion binding is stale.");
  }
  const expectedPrevious = existing.decisions.length === 0 ? null : {
    schemaVersion: existing.schemaVersion,
    digest: digest(existing),
  } as const;
  if (canonicalizeMetadata(decision.previousHistory) !== canonicalizeMetadata(expectedPrevious)) {
    throw new Error("Review decision previous-history binding is stale.");
  }
  validateDecisionSemantics(decision, existing.decisions);
  validateBehaviorReview(loaded.assertionDocument, asBehaviorReview(decision));
  const history: ReviewHistory = { ...existing, decisions: [...existing.decisions, structuredClone(decision)] };
  validateReviewHistory(selection, history);
  await writeMetadataAtomically(dirname(resolve(historyPath)), resolve(historyPath).split(sep).at(-1)!, history, undefined, { overwrite: true });
  return { appended: true, history };
}

export function summarizeCalibration(selection: ReviewSample, history: ReviewHistory): CalibrationSummary {
  validateReviewHistory(selection, history);
  const byCategory = new Map<string, ReviewCandidate[]>();
  for (const candidate of selection.candidates) {
    const group = byCategory.get(candidate.context.categoryId) ?? [];
    group.push(candidate);
    byCategory.set(candidate.context.categoryId, group);
  }
  const summary: CalibrationSummary = {
    schemaVersion: "ebo.calibration-summary/v1",
    selection: { schemaVersion: selection.schemaVersion, digest: digest(selection) },
    history: { schemaVersion: history.schemaVersion, digest: digest(history) },
    totals: counts(selection.candidates, history.decisions),
    categories: [...byCategory].sort(([left], [right]) => left.localeCompare(right))
      .map(([categoryId, candidates]) => ({ categoryId, counts: counts(candidates, history.decisions) })),
  };
  assertValid("calibration summary", summary);
  return summary;
}

export function validateReviewHistory(selection: ReviewSample, history: ReviewHistory): void {
  assertValid("review sample", selection);
  assertValid("review history", history);
  if (history.selection.digest !== digest(selection)) throw new Error("Review history selection binding is stale.");
  const ids = new Set<string>();
  for (const [index, decision] of history.decisions.entries()) {
    if (ids.has(decision.id)) throw new Error(`Review history repeats decision "${decision.id}".`);
    ids.add(decision.id);
    const matchingId = selection.candidates.filter(({ assertion }) => assertion.id === decision.assertion.id);
    if (matchingId.length === 0) throw new Error(`Review history targets unknown assertion "${decision.assertion.id}".`);
    const candidate = matchingId.find(({ assertion }) => assertionKey(assertion) === assertionKey(decision.assertion));
    if (candidate === undefined) throw new Error(`Review history decision "${decision.id}" has a stale assertion binding.`);
    if (canonicalizeMetadata(candidate.assertion) !== canonicalizeMetadata(decision.assertion)) {
      throw new Error(`Review history decision "${decision.id}" has a stale assertion binding.`);
    }
    const prefix: ReviewHistory = { ...history, decisions: history.decisions.slice(0, index) };
    const expected = index === 0 ? null : { schemaVersion: history.schemaVersion, digest: digest(prefix) };
    if (canonicalizeMetadata(decision.previousHistory) !== canonicalizeMetadata(expected)) {
      throw new Error(`Review history decision "${decision.id}" has a stale previous-history binding.`);
    }
    validateDecisionSemantics(decision, history.decisions.slice(0, index));
  }
}

async function loadCandidate(source: ReviewSourceSet["sources"][number]): Promise<LoadedCandidate> {
  const bundleRoot = resolve(source.bundleRoot);
  const assertionPath = resolve(source.assertionPath);
  const assertionDocument = readJson(assertionPath) as BehaviorAssertion;
  const evidence = await createAgentSdkBehaviorEvidence(bundleRoot);
  await validateBehaviorAssertion(assertionDocument, evidence.dataset, evidence.resolver);
  const manifest = readManifest(bundleRoot);
  if (manifest.run.id !== assertionDocument.runId || manifest.attempt.id !== assertionDocument.attemptId) {
    throw new Error(`Review assertion "${assertionDocument.id}" belongs to another run bundle.`);
  }
  const verifier = evidence.capture.records.find(({ record }) => record.kind === "verifier")?.record.document as { status?: unknown } | undefined;
  const outcome: Outcome = manifest.run.assessmentMode === "observational" ? "unavailable"
    : ["passed", "failed", "not-run", "error"].includes(String(verifier?.status)) ? verifier!.status as Outcome : "unavailable";
  return {
    assertion: { id: assertionDocument.id, schemaVersion: assertionDocument.schemaVersion, digest: digest(assertionDocument) },
    source: { bundleRoot, assertionPath },
    context: {
      runId: manifest.run.id,
      attemptId: manifest.attempt.id,
      taskId: manifest.run.task.id,
      taskContext: source.taskContext,
      modelId: manifest.run.model.id,
      harnessId: manifest.run.harness.id,
      terminalState: manifest.terminal.state,
      outcome,
      categoryId: assertionDocument.behavior.categoryId,
      abstained: assertionDocument.judgment.disposition === "abstained",
      confidence: assertionDocument.judgment.disposition === "assessed" ? assertionDocument.judgment.confidence.value : null,
    },
    assertionDocument,
    manifest,
    capture: evidence.capture,
  };
}

async function reloadCandidate(candidate: ReviewCandidate): Promise<LoadedCandidate> {
  const loaded = await loadCandidate({ ...candidate.source, taskContext: candidate.context.taskContext });
  if (canonicalizeMetadata(publicCandidate(loaded)) !== canonicalizeMetadata(candidate)) {
    throw new Error(`Review candidate "${candidate.assertion.id}" source metadata changed after selection.`);
  }
  return loaded;
}

function publicCandidate(candidate: LoadedCandidate): ReviewCandidate {
  const { assertionDocument: _assertionDocument, manifest: _manifest, capture: _capture, ...result } = candidate;
  return structuredClone(result);
}

function matchesFilters(candidate: ReviewCandidate, filters: ReviewFilters): boolean {
  const values: Array<[readonly unknown[] | undefined, unknown]> = [
    [filters.taskIds, candidate.context.taskId],
    [filters.modelIds, candidate.context.modelId],
    [filters.harnessIds, candidate.context.harnessId],
    [filters.outcomes, candidate.context.outcome],
    [filters.terminalStates, candidate.context.terminalState],
    [filters.categoryIds, candidate.context.categoryId],
    [filters.abstentions, candidate.context.abstained],
  ];
  if (values.some(([allowed, value]) => allowed !== undefined && !allowed.includes(value))) return false;
  const confidence = candidate.context.confidence;
  if (filters.confidence === undefined) return true;
  if (confidence === null) return false;
  return (filters.confidence.min === undefined || confidence >= filters.confidence.min)
    && (filters.confidence.max === undefined || confidence <= filters.confidence.max);
}

function packetItem(root: string, candidate: LoadedCandidate): any {
  const descriptors = new Map(candidate.manifest.evidence.map((descriptor) => [descriptor.id, descriptor]));
  return {
    assertion: structuredClone(candidate.assertionDocument),
    assertionBinding: structuredClone(candidate.assertion),
    context: structuredClone(candidate.context),
    source: { evidenceRoot: toPosix(relative(root, candidate.source.bundleRoot)) || "." },
    citations: candidate.assertionDocument.judgment.citations.map((citation) => {
      const descriptor = descriptors.get(citation.nativeReference.artifactId);
      const relativePath = citation.nativeReference.artifactId === "manifest" ? "manifest.json" : descriptor?.relativePath;
      if (relativePath === undefined) throw new Error(`Assertion "${candidate.assertion.id}" cites an unknown native artifact.`);
      const target = relative(root, join(candidate.source.bundleRoot, relativePath));
      const content = resolveCitationContent(candidate, citation.nativeReference);
      return {
        ...structuredClone(citation),
        sharingClass: descriptor?.sharingClass ?? "restricted",
        href: `evidence/${createHash("sha256").update(canonicalizeMetadata([candidate.assertion, citation])).digest("hex")}.html`,
        nativeHref: encodeURI(toPosix(target)),
        content,
      };
    }),
  };
}

function renderPacketHtml(packet: { createdAt: string; items: readonly any[] }): string {
  const items = packet.items.map((item) => {
    const assertion = item.assertion as BehaviorAssertion;
    const citations = (item.citations as Array<{ eventId: string; href: string; sharingClass: string; nativeReference: { recordLocator: string } }>)
      .map((citation) => `<li><a href="${escapeHtml(citation.href)}">${escapeHtml(citation.eventId)}</a> — ${escapeHtml(citation.nativeReference.recordLocator)} (${escapeHtml(citation.sharingClass)})</li>`).join("");
    return `<article id="${anchor(assertionKey(item.assertionBinding))}"><h2>${escapeHtml(assertion.id)}</h2><dl><dt>Run / attempt</dt><dd>${escapeHtml(item.context.runId)} / ${escapeHtml(item.context.attemptId)}</dd><dt>Task</dt><dd>${escapeHtml(item.context.taskId)}</dd><dt>Task context</dt><dd>${escapeHtml(item.context.taskContext)}</dd><dt>Model / harness</dt><dd>${escapeHtml(item.context.modelId)} / ${escapeHtml(item.context.harnessId)}</dd><dt>Outcome</dt><dd>${escapeHtml(item.context.outcome)}</dd><dt>Category</dt><dd>${escapeHtml(item.context.categoryId)}</dd></dl><h3>Judgment</h3><p>${escapeHtml(assertion.judgment.disposition === "assessed" ? assertion.judgment.assessment : `abstained: ${assertion.judgment.reason}`)}</p><h3>Rationale</h3><p>${escapeHtml(assertion.judgment.rationale)}</p><h3>Alternative explanation</h3><p>${escapeHtml(assertion.judgment.alternativeExplanation)}</p><h3>Native evidence</h3><ul>${citations || "<li>No citations (judge abstention).</li>"}</ul><p><a href="#top">Back to index</a></p></article>`;
  }).join("\n");
  const index = packet.items.map((item) => `<li><a href="#${anchor(assertionKey(item.assertionBinding))}">${escapeHtml(item.assertion.id)} — ${escapeHtml(item.context.runId)} / ${escapeHtml(item.context.attemptId)}</a></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>EBO human review packet</title><style>body{font:16px/1.5 system-ui;max-width:72rem;margin:auto;padding:2rem}article{border-top:1px solid #bbb;margin-top:2rem}dt{font-weight:700}dd{margin-bottom:.5rem}code{overflow-wrap:anywhere}</style></head><body id="top"><h1>EBO human review packet</h1><p>Restricted local evidence. Exact cited records are copied into this packet; links return to the native source artifacts.</p><p>Created ${escapeHtml(packet.createdAt)}</p><nav aria-label="Assertions"><ol>${index}</ol></nav>${items}</body></html>\n`;
}

function renderEvidenceHtml(citation: any): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(citation.eventId)}</title><style>body{font:16px/1.5 system-ui;max-width:72rem;margin:auto;padding:2rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #bbb;padding:1rem}</style></head><body><h1>${escapeHtml(citation.eventId)}</h1><p>Restricted local evidence extracted from <a href="../${escapeHtml(citation.nativeHref)}">the native artifact</a> at <code>${escapeHtml(citation.nativeReference.recordLocator)}</code>.</p><pre>${escapeHtml(canonicalizeMetadata(citation.content))}</pre><p><a href="../index.html">Back to packet</a></p></body></html>\n`;
}

function resolveCitationContent(candidate: LoadedCandidate, reference: { artifactId: string; recordLocator: string }): unknown {
  const captured = candidate.capture.records.find(({ reference: current }) => current.artifactId === reference.artifactId
    && current.recordLocator === reference.recordLocator);
  if (captured === undefined) throw new Error(`Assertion "${candidate.assertion.id}" cites a native record that cannot be rendered.`);
  return structuredClone(captured.record.document);
}

function validateDecisionSemantics(decision: ReviewDecision, prior: readonly ReviewDecision[]): void {
  if (decision.kind === "review" && decision.adjudicates !== undefined) throw new Error("A review decision cannot adjudicate prior decisions.");
  if (decision.kind !== "adjudication") return;
  if (decision.adjudicates === undefined || decision.adjudicates.length < 2) throw new Error("An adjudication must bind at least two prior review decisions.");
  if (new Set(decision.adjudicates).size !== decision.adjudicates.length) throw new Error("Adjudication decision IDs must be unique.");
  for (const id of decision.adjudicates) {
    const target = prior.find((candidate) => candidate.id === id);
    if (target === undefined || target.kind !== "review" || assertionKey(target.assertion) !== assertionKey(decision.assertion)) {
      throw new Error(`Adjudication targets unknown or unrelated review decision "${id}".`);
    }
  }
  const current = latestHumanReviews(prior.filter(({ assertion }) => assertionKey(assertion) === assertionKey(decision.assertion)))
    .map(({ id }) => id).sort();
  if (canonicalizeMetadata([...decision.adjudicates].sort()) !== canonicalizeMetadata(current)) {
    throw new Error("Adjudication must bind the current latest decision from every reviewer.");
  }
}

function asBehaviorReview(decision: ReviewDecision): BehaviorReview {
  return {
    schemaVersion: "ebo.behavior-review/v1",
    id: decision.id,
    assertion: structuredClone(decision.assertion),
    state: decision.state,
    reviewer: structuredClone(decision.reviewer),
    rationale: decision.rationale,
  };
}

function counts(candidates: readonly ReviewCandidate[], decisions: readonly ReviewDecision[]): CalibrationCounts {
  const ids = new Set(candidates.map(({ assertion }) => assertionKey(assertion)));
  const relevant = decisions.filter(({ assertion }) => ids.has(assertionKey(assertion)));
  const latestReviews = latestHumanReviews(relevant);
  const judgeHuman = latestReviews.filter(({ state, assertion }) => state !== "insufficient-evidence"
    && candidates.find((candidate) => assertionKey(candidate.assertion) === assertionKey(assertion))?.context.abstained === false);
  const pairResults: boolean[] = [];
  for (const candidate of candidates) {
    const reviews = latestReviews.filter(({ assertion, state }) => assertionKey(assertion) === assertionKey(candidate.assertion)
      && state !== "insufficient-evidence");
    for (let left = 0; left < reviews.length; left += 1) {
      for (let right = left + 1; right < reviews.length; right += 1) pairResults.push(reviews[left]!.state === reviews[right]!.state);
    }
  }
  const outcomes = candidates.map((candidate) => effectiveOutcome(candidate, relevant));
  const disputed = candidates.filter((candidate, index) => {
    if (outcomes[index] !== "unresolved") return false;
    const reviews = latestReviews.filter(({ assertion }) => assertionKey(assertion) === assertionKey(candidate.assertion));
    return reviews.some(({ state }) => state === "disputed") || new Set(reviews.filter(({ state }) => state !== "insufficient-evidence").map(({ state }) => state)).size > 1;
  }).length;
  const adjudications = relevant.filter(({ kind }) => kind === "adjudication");
  return {
    selectedAssertions: candidates.length,
    judgeAbstentions: candidates.filter(({ context }) => context.abstained).length,
    humanDecisionAbstentions: relevant.filter(({ state }) => state === "insufficient-evidence").length,
    disputedAssertions: disputed,
    unresolvedAssertions: outcomes.filter((outcome) => outcome === "unresolved" || outcome === "unreviewed" || outcome === "judge-abstained").length,
    confirmedEligibleAssertions: outcomes.filter((outcome) => outcome === "confirmed").length,
    rejectedAssertions: outcomes.filter((outcome) => outcome === "rejected").length,
    judgeHumanAgreement: agreement(judgeHuman.map(({ state }) => state === "confirmed"), "judge-human decision pairs on non-abstaining assertions"),
    humanHumanAgreement: agreement(pairResults, "distinct-human reviewer pairs on the same assertion with comparable decisions"),
    adjudication: {
      denominator: adjudications.length,
      population: "human adjudication decisions",
      confirmed: adjudications.filter(({ state }) => state === "confirmed").length,
      rejected: adjudications.filter(({ state }) => state === "rejected").length,
      unresolved: adjudications.filter(({ state }) => state === "disputed" || state === "insufficient-evidence").length,
    },
  };
}

function effectiveOutcome(candidate: ReviewCandidate, decisions: readonly ReviewDecision[]): "confirmed" | "rejected" | "unresolved" | "unreviewed" | "judge-abstained" {
  if (candidate.context.abstained) return "judge-abstained";
  const own = decisions.filter(({ assertion }) => assertionKey(assertion) === assertionKey(candidate.assertion));
  const lastReviewIndex = own.findLastIndex(({ kind }) => kind === "review");
  const adjudicationIndex = own.findLastIndex(({ kind }) => kind === "adjudication");
  const adjudication = adjudicationIndex > lastReviewIndex ? own[adjudicationIndex] : undefined;
  if (adjudication !== undefined) return adjudication.state === "confirmed" ? "confirmed" : adjudication.state === "rejected" ? "rejected" : "unresolved";
  const reviews = latestHumanReviews(own);
  if (reviews.length === 0) return "unreviewed";
  if (reviews.some(({ state }) => state === "disputed" || state === "insufficient-evidence")) return "unresolved";
  const states = new Set(reviews.map(({ state }) => state));
  if (states.size !== 1) return "unresolved";
  return states.has("confirmed") ? "confirmed" : "rejected";
}

function latestHumanReviews(decisions: readonly ReviewDecision[]): ReviewDecision[] {
  const latest = new Map<string, ReviewDecision>();
  for (const decision of decisions) {
    if (decision.kind === "review") latest.set(`${assertionKey(decision.assertion)}\u0000${decision.reviewer.id}`, decision);
  }
  return [...latest.values()];
}

function agreement(results: readonly boolean[], population: string): Agreement {
  if (results.length === 0) return { status: "unavailable", denominator: 0, population, reason: "No comparable decisions are available." };
  const agreements = results.filter(Boolean).length;
  return { status: "available", denominator: results.length, population, agreements, disagreements: results.length - agreements, rate: agreements / results.length };
}

function readManifest(bundleRoot: string): RunManifest {
  const path = join(bundleRoot, "manifest.json");
  const manifest = readJson(path);
  const errors = [...validateArtifact(path, manifest), ...validateRunManifestEvidence(path, manifest, bundleRoot)];
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  return manifest as RunManifest;
}

function readJson(path: string): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(path));
  assertNoDuplicateJsonKeys(text);
  return JSON.parse(text);
}

function assertValid(label: string, value: unknown): void {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}

function digest(value: unknown): DigestString {
  return `sha256:${digestMetadata(value).value}`;
}

function seededKey(seed: string, stratum: string, assertion: ReviewCandidate["assertion"]): string {
  return createHash("sha256").update(canonicalizeMetadata([seed, stratum, assertion.id, assertion.digest])).digest("hex");
}

export function assertCalibrationDestination(sourceRoots: readonly string[], destination: string): void {
  const requested = resolve(destination);
  let ancestor = requested;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const output = resolve(realpathSync(ancestor), relative(ancestor, requested));
  for (const root of sourceRoots.map((sourceRoot) => realpathSync(sourceRoot))) {
    const locator = relative(root, output);
    if (locator === "" || locator !== ".." && !locator.startsWith(`..${sep}`)) {
      throw new Error("Calibration outputs must be written outside immutable source evidence.");
    }
  }
}

function assertionKey(assertion: ReviewCandidate["assertion"]): string {
  return canonicalizeMetadata([assertion.id, assertion.schemaVersion, assertion.digest]);
}

function anchor(value: string): string {
  return `assertion-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
