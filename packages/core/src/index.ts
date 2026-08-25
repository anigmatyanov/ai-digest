export {
  BudgetExceededError,
  DigestError,
  LlmContractError,
  SourceDriftError,
  SourceUnavailableError,
} from "./errors.js";

export { EnvSchema, loadEnv, loadEnvFile, MissingEnvError, requireEnv, resetEnvCache } from "./env.js";
export type { Env } from "./env.js";

export {
  CandidateSchema,
  CandidateStatus,
  CardSchema,
  CardType,
  ClaimSchema,
  IssueSchema,
  IsoDateTime,
  RawItemDraftSchema,
  RawItemSchema,
  Url,
} from "./schema/domain.js";

export type { Candidate, Card, Claim, Issue, RawItem, RawItemDraft } from "./types.js";

export { defineStage, EmptyStageInputError, sizeOf } from "./pipeline/stage.js";
export type {
  LlmGateway,
  LlmUsage,
  Repo,
  RunContext,
  Stage,
  StageDefinition,
  StageLogger,
} from "./pipeline/stage.js";

export { formatFunnel, runPipeline } from "./pipeline/pipeline.js";
export type { PipelineOptions, RunReport, StageRecord } from "./pipeline/pipeline.js";

export { assertPlausibleYield, defineConnector, parseOrDrift } from "./connector.js";
export type {
  AnyConnector,
  ConnectorContext,
  ConnectorDefinition,
  ConnectorPolicy,
  HttpClient,
  HttpResponse,
  Page,
} from "./connector.js";

export { MemoryRepo } from "./pipeline/memory-repo.js";
export {
  canonicaliseUrl,
  htmlToText,
  normalizeStage,
  sha256,
} from "./pipeline/stages/normalize.js";
export { applyPrefilter, prefilterStage } from "./pipeline/stages/prefilter.js";
export type { PrefilterPolicy, PrefilterOutcome } from "./pipeline/stages/prefilter.js";
export {
  buildExtractPrompt,
  AcceptedExtractionSchema,
  ExtractionSchema,
  normaliseExtraction,
  extractStage,
  normaliseForQuoteMatch,
  verifyQuotes,
} from "./pipeline/stages/extract.js";
export type { Extraction, ExtractProfile } from "./pipeline/stages/extract.js";
export {
  renderIssue,
  renderStage,
  selectCards,
  selectStage,
} from "./pipeline/stages/select-render.js";
export type { SelectionPolicy, SelectionOutcome, SelectProfile } from "./pipeline/stages/select-render.js";
