/**
 * Harbor integration for the Engineering Behavior Observatory. Harbor
 * (pinned Python package) owns task semantics — task definition, content
 * identity, Docker environments, and verification — while EBO retains
 * orchestration, capture, and governance on top of the native harness
 * adapters. See docs/development/harbor-adr.md for the decision record.
 */
export {
  HARBOR_PACKAGE_PIN,
  HarborAdapterError,
  createHarborAdapter,
  type HarborAdapter,
  type HarborDockerPreflight,
  type HarborVersionInfo,
} from "./adapter.js";

export {
  harborTaskSourceId,
  inspectHarborTask,
  isSafeHarborRelativePath,
  resolveHarborTask,
  snapshotHarborTask,
  toDigest,
  toPrefixedDigest,
  type HarborEnvironmentProfile,
  type HarborStepSummary,
  type HarborTaskInspection,
  type HarborTaskResolution,
  type HarborTaskSummary,
  type HarborVerifierProfile,
} from "./tasks.js";

export {
  admitHarborTask,
  freezeHarborTask,
  harborStudyPaths,
  prepareHarborAdmission,
  preAdmissionDigestOf,
  admissionDigestOf,
  freezeDigestOf,
  readHarborStudyJson,
  statusHarborTask,
  type HarborAdmissionRecord,
  type HarborFreezeRecord,
  type HarborProvenanceInput,
  type HarborReviewRecord,
  type HarborTaskStatus,
} from "./study.js";

export {
  compileHarborRunQueue,
  harborRunId,
  readRunQueueVersioned,
  validateHarborRunQueue,
  type ExperimentConfigurationV2,
  type FrozenHarborTaskIdentity,
  type HarborExecutionProfile,
  type RunQueueV2,
  type TaskSourceCondition,
} from "./queue.js";

export {
  HarborPreflightError,
  prepareHarborExecution,
  type PreparedHarborExecution,
  type PreparedHarborStep,
} from "./execution.js";

export {
  HARBOR_ATTEMPT_SCHEMA_VERSION,
  runHarborBackedQueueEntry,
  type HarborHarnessStepExecutor,
  type HarborRunSummary,
  type HarborStepExecution,
  type HarborStepExecutorInput,
} from "./runner.js";

export {
  createClaudeAgentSdkHarborExecutor,
  createCodexHarborExecutor,
  createCursorHarborExecutor,
  createDeepSeekHarborExecutor,
  createOpenHandsHarborExecutor,
  createPiHarborExecutor,
  harborStepBundleDefinition,
  type ClaudeAgentSdkHarborExecutorOptions,
  type CodexHarborExecutorOptions,
  type CursorHarborExecutorOptions,
  type DeepSeekHarborExecutorOptions,
  type HarborHarnessConfigurationReferences,
  type OpenHandsHarborExecutorOptions,
  type PiHarborExecutorOptions,
} from "./harnesses.js";

export {
  convertLegacyTaskPacket,
  conversionReportDigest,
  HARBOR_CONVERSION_SCHEMA_VERSION,
  readHarborConversionReport,
  type HarborConversionFieldMapping,
  type HarborConversionOutcome,
  type HarborConversionReport,
} from "./convert.js";
