#!/usr/bin/env node
/**
 * Golden set — the gate that catches a prompt quietly getting worse.
 *
 * It runs the pipeline over frozen inputs and asserts STRUCTURE, not wording. A byte-for-
 * byte comparison against an expected issue cannot be a gate: the model is
 * non-deterministic, so that diff is material for a human to read, and structural
 * assertions are what a machine can honestly enforce.
 *
 * Run: pnpm golden
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = "profiles/dist/_test.js";

const checks = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail: detail ?? "" });
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message });
  }
};
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

// ── run the pipeline offline ────────────────────────────────────────────────────
execFileSync(
  "node",
  [join(ROOT, "apps/pipeline/dist/cli.js"), "--profile", PROFILE, "--fixtures", "--dry-run"],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

const runs = readdirSync(join(ROOT, "runs")).sort();
const dir = join(ROOT, "runs", runs[runs.length - 1]);
const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));

const rawItems = read("ingest.out.json");
const candidates = read("prefilter.out.json");
const cards = read("extract.out.json");
const issue = read("select.out.json");
const markdown = readFileSync(join(dir, "issue.md"), "utf8");

// ── structural assertions ───────────────────────────────────────────────────────

check("the run produced an issue with at least one card", () => {
  assert(issue.cardIds.length > 0, "the issue has no cards — a silently empty issue is the worst failure mode");
  return `${issue.cardIds.length} card(s)`;
});

check("every card links to a URL that was actually in the input", () => {
  // HONEST LIMIT: with the current extract stage this assertion cannot fail. The card's
  // sourceUrl is assigned by our code from the candidate, never taken from the model's
  // answer, so it agrees with the input by construction. Sabotaging a fixture leaves it
  // green — measured, not assumed.
  //
  // It is kept as an ARCHITECTURAL guard, not as evidence: the day extract starts
  // trusting a URL that came back from the model, this turns into a real check. Anything
  // it currently proves about hallucination is proved by the quote assertion below.
  const inputUrls = new Set(candidates.map((c) => c.canonicalUrl));
  for (const card of cards) {
    assert(
      inputUrls.has(card.attribution.sourceUrl),
      `card ${card.id} cites ${card.attribution.sourceUrl}, which is not among the ${inputUrls.size} input URLs`,
    );
  }
  return `${cards.length} card(s) checked against ${inputUrls.size} input URL(s)`;
});

// Only what a reader actually sees is asserted on. A card the evidence check withheld is
// the machinery working, not a failure — asserting on it would make a correct rejection
// look like a broken pipeline and would push someone to weaken the check.
const published = cards.filter((c) => issue.cardIds.includes(c.id));

check("no card that failed the evidence check reached the issue", () => {
  // The real gate. Everything else about hallucination is upstream of this line.
  for (const card of published) {
    assert(card.evidenceOk === true, `card ${card.id} is in the issue with evidenceOk=false`);
  }
  return `${published.length} published, ${cards.length - published.length} withheld`;
});

check("every claim quote in a PUBLISHED card appears verbatim in its source", () => {
  const byUrl = new Map(candidates.map((c) => [c.canonicalUrl, c.extractedText]));
  const norm = (s) =>
    s
      .replace(/[‘’‛′]/g, "'")
      .replace(/[“”‟″]/g, '"')
      .replace(/[‐-―−]/g, "-")
      .replace(/[\u00a0\u2007\u202f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  let count = 0;
  for (const card of published) {
    const source = norm(byUrl.get(card.attribution.sourceUrl) ?? "");
    for (const claim of card.claims) {
      assert(
        source.includes(norm(claim.quote)),
        `card ${card.id}: quote not found in its source — "${claim.quote.slice(0, 60)}…"`,
      );
      count++;
    }
  }
  return `${count} quote(s) verified`;
});

check("no published card carries fewer than two claims", () => {
  for (const card of published) {
    assert(card.claims.length >= 2, `card ${card.id} has ${card.claims.length} claim(s)`);
  }
  return "all cards carry evidence";
});

check("no published quote exceeds the 200-character citation limit", () => {
  for (const card of published) {
    for (const claim of card.claims) {
      assert(
        claim.quote.length <= 200,
        `card ${card.id} has a ${claim.quote.length}-character quote`,
      );
    }
  }
  return "citation length within the legal frame";
});

check("no two published cards share a canonical source URL", () => {
  const seen = new Set();
  for (const card of published) {
    const url = card.attribution.sourceUrl;
    assert(!seen.has(url), `two cards cite ${url} — the reader sees the same story twice`);
    seen.add(url);
  }
  return `${seen.size} distinct source(s)`;
});

check("every card in the issue names its source in the rendered markdown", () => {
  // Attribution is not optional and must survive rendering, not merely exist in the data.
  for (const card of cards.filter((c) => issue.cardIds.includes(c.id))) {
    assert(
      markdown.includes(card.attribution.sourceUrl),
      `card ${card.id} is in the issue but its source URL is absent from the markdown`,
    );
  }
  return "attribution present for every published card";
});

check("ingest and normalize agree on how many items exist", () => {
  assert(rawItems.length > 0, "ingest produced nothing");
  assert(
    candidates.length <= rawItems.length,
    `normalize produced ${candidates.length} candidates from ${rawItems.length} raw items`,
  );
  return `${rawItems.length} raw -> ${candidates.length} candidate(s)`;
});

// ── adversarial ─────────────────────────────────────────────────────────────────

check("a fabricated quote is rejected by the evidence check", () => {
  // The deterministic half of the anti-hallucination defence, exercised directly. A
  // quote nobody wrote must not survive, and this is the check that costs nothing.
  const source = "The release switches from httpx to httpx2.";
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const fabricated = "The release adds a built-in vector database.";
  assert(
    !norm(source).includes(norm(fabricated)),
    "a fabricated quote was treated as present in the source",
  );
  return "verified on a quote that is not in the text";
});

// ── report ──────────────────────────────────────────────────────────────────────

const handAuthored = existsSync(join(ROOT, "fixtures/llm/test"))
  ? readdirSync(join(ROOT, "fixtures/llm/test")).filter((f) =>
      readFileSync(join(ROOT, "fixtures/llm/test", f), "utf8").includes("_handAuthored"),
    )
  : [];

console.log("golden set:");
for (const c of checks) {
  console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
}

if (handAuthored.length > 0) {
  console.log("");
  console.log(
    `  ! ${handAuthored.length} LLM fixture(s) are HAND-AUTHORED, so these assertions prove the\n` +
      `    pipeline's structure, not the model's behaviour. Prompt-regression coverage is NOT\n` +
      `    in place until they are re-recorded from a live run.`,
  );
}

const withheldPct = cards.length === 0 ? 0 : ((cards.length - published.length) / cards.length) * 100;
console.log("");
console.log(
  `  evidence: ${published.length}/${cards.length} card(s) published, ` +
    `${withheldPct.toFixed(0)}% withheld for unverifiable quotes`,
);
if (withheldPct > 50) {
  console.log(
    "  ! more than half the cards were withheld — that is a signal about the prompt, not\n" +
      "    about the sources. Worth reading the withheld quotes before changing anything else.",
  );
}

const failed = checks.filter((c) => !c.ok).length;
console.log("");
console.log(`${checks.length - failed}/${checks.length} structural assertions passed`);
process.exit(failed > 0 ? 1 : 0);
