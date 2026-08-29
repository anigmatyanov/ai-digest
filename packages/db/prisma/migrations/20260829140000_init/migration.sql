-- Initial schema.
--
-- The extension comes FIRST and is not negotiable: two tables below declare vector(384)
-- columns, and Postgres rejects the type before the extension exists. Prisma does not emit
-- this line, because the schema deliberately does not declare `extensions = [vector]` (that
-- needs a preview feature); so it lives here, where it will still mean the same thing in
-- two years.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "topics" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lang" VARCHAR(2) NOT NULL,
    "profileJson" JSONB NOT NULL,
    "profileHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "cursor" JSONB,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "itemsMedian" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lastFetchedAt" TIMESTAMP(3),
    "health" TEXT NOT NULL DEFAULT 'ok',

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_items" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "author" TEXT,
    "publishedAt" TIMESTAMP(3),
    "body" TEXT,
    "bodyFormat" TEXT NOT NULL DEFAULT 'text',
    "lang" VARCHAR(2),
    "signals" JSONB NOT NULL DEFAULT '{}',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "raw_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "statusReason" TEXT,
    "canonicalUrl" TEXT NOT NULL,
    "canonicalUrlHash" CHAR(64) NOT NULL,
    "title" TEXT NOT NULL,
    "lang" VARCHAR(2),
    "publishedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentHash" CHAR(64) NOT NULL,
    "extractedText" TEXT NOT NULL,
    "prefilterScore" DOUBLE PRECISION,
    "score" DOUBLE PRECISION,
    "scoreBreakdown" JSONB,
    "simhash" BIGINT,
    "embedding" vector(384),
    "duplicateOfId" TEXT,
    "cycleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_raw_items" (
    "candidateId" TEXT NOT NULL,
    "rawItemId" TEXT NOT NULL,

    CONSTRAINT "candidate_raw_items_pkey" PRIMARY KEY ("candidateId","rawItemId")
);

-- CreateTable
CREATE TABLE "cards" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "techniqueKey" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "steps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "claims" JSONB NOT NULL,
    "attribution" JSONB NOT NULL,
    "evidenceOk" BOOLEAN NOT NULL DEFAULT false,
    "promptVersion" TEXT NOT NULL,
    "techniqueEmbedding" vector(384),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "reviewSentAt" TIMESTAMP(3),
    "reviewDeadline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_cards" (
    "issueId" TEXT NOT NULL,
    "cardId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "issue_cards_pkey" PRIMARY KEY ("issueId","cardId")
);

-- CreateTable
CREATE TABLE "pipeline_runs" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "metrics" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "pipeline_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_runs" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "inputCount" INTEGER NOT NULL DEFAULT 0,
    "outputCount" INTEGER NOT NULL DEFAULT 0,
    "checkpoint" JSONB,
    "error" TEXT,

    CONSTRAINT "stage_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "topics_slug_key" ON "topics"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "sources_topicId_key_key" ON "sources"("topicId", "key");

-- CreateIndex
CREATE INDEX "raw_items_fetchedAt_idx" ON "raw_items"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "raw_items_sourceId_externalId_key" ON "raw_items"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "candidates_topicId_status_idx" ON "candidates"("topicId", "status");

-- CreateIndex
CREATE INDEX "candidates_cycleId_idx" ON "candidates"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "candidates_topicId_canonicalUrlHash_key" ON "candidates"("topicId", "canonicalUrlHash");

-- CreateIndex
CREATE INDEX "cards_candidateId_idx" ON "cards"("candidateId");

-- CreateIndex
CREATE INDEX "cards_techniqueKey_idx" ON "cards"("techniqueKey");

-- CreateIndex
CREATE INDEX "issues_state_reviewDeadline_idx" ON "issues"("state", "reviewDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "issues_topicId_cycleId_key" ON "issues"("topicId", "cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "issue_cards_issueId_position_key" ON "issue_cards"("issueId", "position");

-- CreateIndex
CREATE INDEX "pipeline_runs_startedAt_idx" ON "pipeline_runs"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pipeline_runs_topicId_cycleId_attempt_key" ON "pipeline_runs"("topicId", "cycleId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "stage_runs_runId_stage_key" ON "stage_runs"("runId", "stage");

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_raw_items" ADD CONSTRAINT "candidate_raw_items_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_raw_items" ADD CONSTRAINT "candidate_raw_items_rawItemId_fkey" FOREIGN KEY ("rawItemId") REFERENCES "raw_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_cards" ADD CONSTRAINT "issue_cards_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_cards" ADD CONSTRAINT "issue_cards_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_runs" ADD CONSTRAINT "stage_runs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "pipeline_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
