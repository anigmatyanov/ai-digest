-- One card per (candidate, technique).
--
-- The table shipped with only a primary key, so a rerun avoided duplicating cards purely
-- because `extract` builds a deterministic id. That is idempotency by convention, and the
-- schema header claims this database does not rely on it. Now it does not.
CREATE UNIQUE INDEX "cards_candidateId_techniqueKey_key" ON "cards"("candidateId", "techniqueKey");
