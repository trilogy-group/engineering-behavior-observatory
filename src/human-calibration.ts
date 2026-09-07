import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import lockfile from "proper-lockfile";

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
  sources: ReviewSourceSet;
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
  capture?: AgentSdkBehaviorEvidence["capture"];
};

type DecisionValidationIndex = {
  byId: Map<string, ReviewDecision>;
  latestReviews: Map<string, Map<string, ReviewDecision>>;
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
  const canonicalSources: ReviewSourceSet = {
    ...structuredClone(sourceSet),
    sources: sourceSet.sources.map((source) => ({
      ...structuredClone(source),
      bundleRoot: resolve(source.bundleRoot),
      assertionPath: resolve(source.assertionPath),
    })),
  };
  const loaded = await loadCandidates(canonicalSources.sources);
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
    sources: canonicalSources,
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
  validateReviewSample(sample);
  return sample;
}

export async function writeReviewPacket(selection: ReviewSample, outputRoot: string, now = () => new Date().toISOString()): Promise<void> {
  await revalidateReviewSample(selection);
  const root = resolve(outputRoot);
  assertCalibrationDestination(selection.sources.sources.map(({ bundleRoot }) => bundleRoot), root);
  if (existsSync(root)) throw new Error("Review packet destination already exists.");
  const parent = dirname(root);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stagingRoot = mkdtempSync(join(parent, ".ebo-review-packet-"));
  let published = false;
  try {
    mkdirSync(join(stagingRoot, "evidence"), { mode: 0o700 });
    const items: any[] = [];
    for (const candidate of selection.candidates) {
      const loaded = await reloadCandidate(candidate);
      if (loaded.assertion.digest !== digest(loaded.assertionDocument)) {
        throw new Error(`Review assertion "${loaded.assertion.id}" changed after sample selection.`);
      }
      const item = packetItem(root, loaded);
      for (const citation of item.citations) {
        writeFileSync(join(stagingRoot, citation.href), renderEvidenceHtml(citation), { encoding: "utf8", mode: 0o600, flag: "wx" });
        delete citation.content;
      }
      items.push(item);
    }
    const packet = {
      schemaVersion: "ebo.review-packet/v1" as const,
      createdAt: now(),
      selection: { schemaVersion: selection.schemaVersion, digest: digest(selection) },
      evidenceBoundary: {
        classification: "restricted-local-only" as const,
        copiedNativeEvidence: true as const,
        note: "Only cited native records are copied into this restricted local packet; links retain the source bundle path. This is not a partner or public export.",
      },
      items,
    };
    assertValid("review packet", packet);
    writeFileSync(join(stagingRoot, "index.html"), renderPacketHtml(packet), { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(join(stagingRoot, "packet.json"), `${canonicalizeMetadata(packet)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(stagingRoot, root);
    published = true;
  } finally {
    if (!published) rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export async function importReviewDecision(
  selection: ReviewSample,
  historyPath: string,
  decision: ReviewDecision,
): Promise<{ appended: boolean; history: ReviewHistory }> {
  await revalidateReviewSample(selection);
  assertValid("human review decision", decision);
  assertCalibrationDestination(selection.sources.sources.map(({ bundleRoot }) => bundleRoot), historyPath);
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(resolve(historyPath), { realpath: false, retries: 0, stale: 30_000, update: 10_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new Error("Another review-history import is already in progress.");
    throw error;
  }
  // ponytail: one local lock serializes imports; use transactional storage only if a hosted multi-writer workflow is introduced.
  try {
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
    validateDecisionSemantics(decision, indexDecisions(existing.decisions));
    validateBehaviorReview(loaded.assertionDocument, asBehaviorReview(decision));
    const history: ReviewHistory = { ...existing, decisions: [...existing.decisions, structuredClone(decision)] };
    validateReviewHistory(selection, history);
    await writeMetadataAtomically(dirname(resolve(historyPath)), resolve(historyPath).split(sep).at(-1)!, history, undefined, { overwrite: true });
    return { appended: true, history };
  } finally {
    await release();
  }
}

export async function summarizeCalibration(selection: ReviewSample, history: ReviewHistory): Promise<CalibrationSummary> {
  await revalidateReviewSample(selection);
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
  validateReviewSample(selection);
  assertValid("review history", history);
  if (history.selection.digest !== digest(selection)) throw new Error("Review history selection binding is stale.");
  const decisionIndex = indexDecisions();
  const candidatesById = new Map<string, ReviewCandidate[]>();
  for (const candidate of selection.candidates) {
    const matches = candidatesById.get(candidate.assertion.id) ?? [];
    matches.push(candidate);
    candidatesById.set(candidate.assertion.id, matches);
  }
  const prefix = createHash("sha256").update('{"decisions":[');
  const suffix = `],"schemaVersion":${canonicalizeMetadata(history.schemaVersion)},"selection":${canonicalizeMetadata(history.selection)}}`;
  for (const [index, decision] of history.decisions.entries()) {
    if (decisionIndex.byId.has(decision.id)) throw new Error(`Review history repeats decision "${decision.id}".`);
    const matchingId = candidatesById.get(decision.assertion.id) ?? [];
    if (matchingId.length === 0) throw new Error(`Review history targets unknown assertion "${decision.assertion.id}".`);
    const candidate = matchingId.find(({ assertion }) => assertionKey(assertion) === assertionKey(decision.assertion));
    if (candidate === undefined) throw new Error(`Review history decision "${decision.id}" has a stale assertion binding.`);
    if (canonicalizeMetadata(candidate.assertion) !== canonicalizeMetadata(decision.assertion)) {
      throw new Error(`Review history decision "${decision.id}" has a stale assertion binding.`);
    }
    const expected = index === 0 ? null : {
      schemaVersion: history.schemaVersion,
      digest: `sha256:${prefix.copy().update(suffix).digest("hex")}` as DigestString,
    };
    if (canonicalizeMetadata(decision.previousHistory) !== canonicalizeMetadata(expected)) {
      throw new Error(`Review history decision "${decision.id}" has a stale previous-history binding.`);
    }
    validateDecisionSemantics(decision, decisionIndex);
    prefix.update(`${index === 0 ? "" : ","}${canonicalizeMetadata(decision)}`);
    indexDecision(decisionIndex, decision);
  }
}

export function validateReviewSample(selection: ReviewSample): void {
  assertValid("review sample", selection);
  const candidateBindings = selection.candidates.map(({ assertion }) => assertionKey(assertion));
  if (new Set(candidateBindings).size !== candidateBindings.length) {
    throw new Error("Review sample candidate bindings must be unique.");
  }
  if (selection.population.sourceCount !== selection.sources.sources.length) {
    throw new Error("Review sample source count does not match its retained source set.");
  }
  if (canonicalizeMetadata(selection.population.selectedAssertionIds)
      !== canonicalizeMetadata(selection.candidates.map(({ assertion }) => assertion.id))) {
    throw new Error("Review sample selected assertion IDs do not match its candidates.");
  }
  if (selection.population.strata.length !== selection.criteria.strata.length) {
    throw new Error("Review sample strata do not match its retained criteria.");
  }
  const matched = new Map<string, number>();
  for (const candidate of selection.candidates) {
    const strata = selection.criteria.strata.filter(({ filters }) => matchesFilters(candidate, filters));
    if (strata.length !== 1) throw new Error(`Review candidate "${candidate.assertion.id}" must match exactly one retained stratum.`);
    matched.set(strata[0]!.id, (matched.get(strata[0]!.id) ?? 0) + 1);
  }
  for (const [index, criterion] of selection.criteria.strata.entries()) {
    const stratum = selection.population.strata[index]!;
    if (stratum.id !== criterion.id || stratum.requested !== criterion.sampleSize
        || stratum.selected !== (matched.get(criterion.id) ?? 0)
        || stratum.selected > stratum.eligible) {
      throw new Error(`Review sample stratum "${criterion.id}" is inconsistent with its criteria or selected candidates.`);
    }
  }
  const unavailable = selection.population.strata.filter(({ eligible }) => eligible === 0).map(({ id }) => id);
  if (canonicalizeMetadata(selection.population.unavailableStrata) !== canonicalizeMetadata(unavailable)
      || selection.population.eligibleAssertionIds.length !== selection.population.strata.reduce((total, { eligible }) => total + eligible, 0)) {
    throw new Error("Review sample eligible or unavailable population is inconsistent with its strata.");
  }
  const sources = new Set(selection.sources.sources.map((source) => sourceKey(
    resolve(source.bundleRoot), resolve(source.assertionPath), source.taskContext,
  )));
  for (const candidate of selection.candidates) {
    if (!sources.has(sourceKey(candidate.source.bundleRoot, candidate.source.assertionPath, candidate.context.taskContext))) {
      throw new Error(`Review candidate "${candidate.assertion.id}" is absent from the retained source set.`);
    }
  }
}

export async function revalidateReviewSample(selection: ReviewSample): Promise<void> {
  validateReviewSample(selection);
  const expected = await selectReviewSample(selection.sources, selection.criteria, () => selection.createdAt);
  if (canonicalizeMetadata(expected) !== canonicalizeMetadata(selection)) {
    throw new Error("Review sample does not match the reproducible selection from its retained sources and criteria.");
  }
}

async function loadCandidates(sources: ReviewSourceSet["sources"]): Promise<LoadedCandidate[]> {
  const grouped = new Map<string, ReviewSourceSet["sources"][number][]>();
  for (const source of sources) {
    const root = resolve(source.bundleRoot);
    const group = grouped.get(root) ?? [];
    group.push(source);
    grouped.set(root, group);
  }
  const loaded: LoadedCandidate[] = [];
  for (const [bundleRoot, group] of grouped) {
    const evidence = await createAgentSdkBehaviorEvidence(bundleRoot);
    const manifest = readManifest(bundleRoot);
    for (const source of group) loaded.push(await loadCandidate(source, evidence, manifest));
  }
  return loaded;
}

async function loadCandidate(
  source: ReviewSourceSet["sources"][number],
  evidence?: AgentSdkBehaviorEvidence,
  manifest?: RunManifest,
  retainCapture = false,
): Promise<LoadedCandidate> {
  const bundleRoot = resolve(source.bundleRoot);
  const assertionPath = resolve(source.assertionPath);
  const assertionDocument = readJson(assertionPath) as BehaviorAssertion;
  const resolvedEvidence = evidence ?? await createAgentSdkBehaviorEvidence(bundleRoot);
  const resolvedManifest = manifest ?? readManifest(bundleRoot);
  await validateBehaviorAssertion(assertionDocument, resolvedEvidence.dataset, resolvedEvidence.resolver);
  if (resolvedManifest.run.id !== assertionDocument.runId || resolvedManifest.attempt.id !== assertionDocument.attemptId) {
    throw new Error(`Review assertion "${assertionDocument.id}" belongs to another run bundle.`);
  }
  const outcome = terminalVerifierOutcome(resolvedEvidence.capture, resolvedManifest);
  return {
    assertion: { id: assertionDocument.id, schemaVersion: assertionDocument.schemaVersion, digest: digest(assertionDocument) },
    source: { bundleRoot, assertionPath },
    context: {
      runId: resolvedManifest.run.id,
      attemptId: resolvedManifest.attempt.id,
      taskId: resolvedManifest.run.task.id,
      taskContext: source.taskContext,
      modelId: resolvedManifest.run.model.id,
      harnessId: resolvedManifest.run.harness.id,
      terminalState: resolvedManifest.terminal.state,
      outcome,
      categoryId: assertionDocument.behavior.categoryId,
      abstained: assertionDocument.judgment.disposition === "abstained",
      confidence: assertionDocument.judgment.disposition === "assessed" ? assertionDocument.judgment.confidence.value : null,
    },
    assertionDocument,
    manifest: resolvedManifest,
    ...(retainCapture ? { capture: resolvedEvidence.capture } : {}),
  };
}

async function reloadCandidate(candidate: ReviewCandidate): Promise<LoadedCandidate> {
  const loaded = await loadCandidate({ ...candidate.source, taskContext: candidate.context.taskContext }, undefined, undefined, true);
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
        nativeHref: encodeRelativePath(target),
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
  const captured = candidate.capture?.records.find(({ reference: current }) => current.artifactId === reference.artifactId
    && current.recordLocator === reference.recordLocator);
  if (captured === undefined) throw new Error(`Assertion "${candidate.assertion.id}" cites a native record that cannot be rendered.`);
  return structuredClone(captured.record.document);
}

export function terminalVerifierOutcome(capture: AgentSdkBehaviorEvidence["capture"], manifest: RunManifest): Outcome {
  if (manifest.run.assessmentMode === "observational") return "unavailable";
  const workspaceId = manifest.terminal.workspaceArtifactId;
  if (workspaceId === undefined) return "unavailable";
  const outcomes = capture.records.flatMap(({ record }) => {
    if (record.kind !== "verifier" || typeof record.document !== "object" || record.document === null) return [];
    const verifier = record.document as { status?: unknown; workspace?: { artifactId?: unknown } };
    return verifier.workspace?.artifactId === workspaceId && ["passed", "failed", "not-run", "error"].includes(String(verifier.status))
      ? [verifier.status as Outcome] : [];
  });
  const distinct = [...new Set(outcomes)];
  if (distinct.length > 1) throw new Error("Run bundle has conflicting verifier outcomes for the terminal workspace.");
  return distinct[0] ?? "unavailable";
}

function validateDecisionSemantics(decision: ReviewDecision, index: DecisionValidationIndex): void {
  if (decision.kind === "review" && decision.adjudicates !== undefined) throw new Error("A review decision cannot adjudicate prior decisions.");
  if (decision.kind !== "adjudication") return;
  if (decision.adjudicates === undefined || decision.adjudicates.length < 2) throw new Error("An adjudication must bind at least two prior review decisions.");
  if (new Set(decision.adjudicates).size !== decision.adjudicates.length) throw new Error("Adjudication decision IDs must be unique.");
  const key = assertionKey(decision.assertion);
  for (const id of decision.adjudicates) {
    const target = index.byId.get(id);
    if (target === undefined || target.kind !== "review" || assertionKey(target.assertion) !== key) {
      throw new Error(`Adjudication targets unknown or unrelated review decision "${id}".`);
    }
  }
  const current = [...(index.latestReviews.get(key)?.values() ?? [])].map(({ id }) => id).sort();
  if (canonicalizeMetadata([...decision.adjudicates].sort()) !== canonicalizeMetadata(current)) {
    throw new Error("Adjudication must bind the current latest decision from every reviewer.");
  }
}

function indexDecisions(decisions: readonly ReviewDecision[] = []): DecisionValidationIndex {
  const index: DecisionValidationIndex = { byId: new Map(), latestReviews: new Map() };
  for (const decision of decisions) indexDecision(index, decision);
  return index;
}

function indexDecision(index: DecisionValidationIndex, decision: ReviewDecision): void {
  index.byId.set(decision.id, decision);
  if (decision.kind !== "review") return;
  const key = assertionKey(decision.assertion);
  const reviews = index.latestReviews.get(key) ?? new Map<string, ReviewDecision>();
  reviews.set(decision.reviewer.id, decision);
  index.latestReviews.set(key, reviews);
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
    const own = relevant.filter(({ assertion }) => assertionKey(assertion) === assertionKey(candidate.assertion));
    if (currentAdjudication(own)?.state === "disputed") return true;
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
  const adjudication = currentAdjudication(own);
  if (adjudication !== undefined) return adjudication.state === "confirmed" ? "confirmed" : adjudication.state === "rejected" ? "rejected" : "unresolved";
  const reviews = latestHumanReviews(own);
  if (reviews.length === 0) return "unreviewed";
  if (reviews.some(({ state }) => state === "disputed" || state === "insufficient-evidence")) return "unresolved";
  const states = new Set(reviews.map(({ state }) => state));
  if (states.size !== 1) return "unresolved";
  return states.has("confirmed") ? "confirmed" : "rejected";
}

function currentAdjudication(decisions: readonly ReviewDecision[]): ReviewDecision | undefined {
  const lastReviewIndex = decisions.findLastIndex(({ kind }) => kind === "review");
  const adjudicationIndex = decisions.findLastIndex(({ kind }) => kind === "adjudication");
  return adjudicationIndex > lastReviewIndex ? decisions[adjudicationIndex] : undefined;
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
  let ancestor = dirname(requested);
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

function encodeRelativePath(path: string): string {
  return toPosix(path).split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function assertionKey(assertion: ReviewCandidate["assertion"]): string {
  return canonicalizeMetadata([assertion.id, assertion.schemaVersion, assertion.digest]);
}

function sourceKey(bundleRoot: string, assertionPath: string, taskContext: string): string {
  return canonicalizeMetadata([bundleRoot, assertionPath, taskContext]);
}

function anchor(value: string): string {
  return `assertion-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value).replace(/[&<>"']/gu, (character) => entities[character]!);
}
