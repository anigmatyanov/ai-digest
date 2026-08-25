/**
 * Domain types. Every one is inferred from its zod schema in `schema/domain.ts`, so a
 * validator and a type cannot describe different shapes.
 */
export type {
  Candidate,
  CandidateStatus,
  Card,
  CardType,
  Claim,
  Issue,
  RawItem,
  RawItemDraft,
} from "./schema/domain.js";
