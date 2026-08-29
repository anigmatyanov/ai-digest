#!/usr/bin/env node
/**
 * Epic backlog index. Zero dependencies, Node 24.
 *
 * The queue is never a hand-maintained table: it is computed from the frontmatter of
 * docs/epics/*.md every time. Epics do not move between directories — a terminal status
 * lives in `status:`, which is why nothing here has to know about archive folders.
 *
 * Modes (exit codes are part of the contract — CI and the slash commands branch on them):
 *   (none)               every epic grouped by status                        exit 0
 *   --ready              epics claimable right now, with blocking reasons    exit 0
 *   --plan               a batch safe to run in parallel + collision map     exit 0
 *   --validate <file...> readiness rubric for draft -> todo                  exit 0 ok / 1 failed
 *   --stale              claims whose branch no longer exists                exit 0 none / 2 found / 3 error
 *   --next-id            next free E-NNN                                     exit 0
 *   --json               machine-readable output for the mode above
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EPIC_DIR = join(ROOT, "docs", "epics");

const ACTIVE = new Set(["todo", "in-progress", "review"]);
const HOLDS_SERIALIZE = new Set(["in-progress", "review"]);
const SIZES = new Set(["S", "M"]);
const AREAS = new Set(["connectors", "pipeline", "llm", "web", "profiles", "infra", "tooling"]);
const STATUSES = new Set(["draft", "todo", "in-progress", "review", "done", "blocked", "dropped"]);

/**
 * Serialize label registry. Mirrors the table in .claude/rules/backlog.md — the
 * self-test below fails when the two disagree, so the doc cannot rot away from the code.
 */
const SERIALIZE_LABELS = {
  "prisma-schema": ["packages/db/prisma/schema.prisma", "packages/db/prisma/migrations/"],
  "pipeline-contract": [
    "packages/core/src/pipeline/pipeline.ts",
    "packages/core/src/pipeline/stage.ts",
  ],
  "core-types": ["packages/core/src/types.ts", "packages/core/src/schema/"],
  "core-errors": ["packages/core/src/errors.ts"],
  "profile-schema": ["profiles/schema.ts"],
  profiles: ["profiles/"],
  prompts: ["packages/llm/src/prompts/"],
  "llm-costs": ["packages/llm/src/cost.ts", "packages/llm/src/pricing.ts", "costs/baseline.json"],
  "env-schema": ["packages/core/src/env.ts", ".env.example"],
  "web-shell": ["apps/web/src/app/layout.tsx", "apps/web/src/app/globals.css"],
  workflows: [".github/workflows/"],
  toolchain: [
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "eslint.config.js",
    "pnpm-workspace.yaml",
  ],
};

// ─────────────────────────── frontmatter ───────────────────────────

/** Strip a trailing `# comment`, but never one inside quotes. */
function stripComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function coerce(value) {
  const v = value.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (/^-?\d+$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, "");
}

/**
 * The single frontmatter parser. Everything that reports on epics goes through it — an
 * intake proposal that disagrees with --validate about what is promotable is worse than
 * no proposal at all.
 */
export function parseEpic(path) {
  const text = readFileSync(path, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { path, file: basename(path), error: "no frontmatter block" };

  // Frontmatter is read line by line, but a value may span lines: Prettier reflows a long
  // inline sequence into a block one, and a human may write either form. Reading only
  // `key: value` turned E-001's nine serialize labels into an empty list — silently, in a
  // commit whose diff looked like pure formatting. Join continuation lines first.
  const rawLines = m[1].split(/\r?\n/);
  const joined = [];
  for (const line of rawLines) {
    if (/^[A-Za-z_][A-Za-z0-9_]*:/.test(line)) joined.push(line);
    else if (joined.length && line.trim() !== "") joined[joined.length - 1] += " " + line.trim();
  }

  const fm = {};
  for (const line of joined) {
    const cleaned = stripComment(line);
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(cleaned);
    if (kv) fm[kv[1]] = coerce(kv[2]);
  }
  const body = text.slice(m[0].length);
  return { path, file: basename(path), fm, body };
}

export function loadEpics() {
  if (!existsSync(EPIC_DIR)) return [];
  return readdirSync(EPIC_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => parseEpic(join(EPIC_DIR, f)))
    .sort((a, b) => String(a.file).localeCompare(String(b.file)));
}

// ─────────────────────────── sections & rubric ───────────────────────────

/**
 * Body of a `## <heading>` section.
 *
 * Matches the heading by prefix, because the template's own headings carry qualifiers —
 * "## Объём — карта файлов", "## Заметки (append-only)". Requiring an exact match made
 * every well-formed epic fail with "## Объём names no path".
 *
 * The terminator is `$(?![\s\S])` rather than `\Z`: JavaScript has no `\Z`, it would be
 * parsed as a literal "Z" and the last section of every file would come back empty.
 */
function section(body, heading) {
  const re = new RegExp(`^##\\s+${heading}[^\\n]*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m");
  return re.exec(body)?.[1] ?? "";
}

export function validateEpic(epic) {
  const problems = [];
  const warnings = [];
  if (epic.error) return { ok: false, problems: [epic.error], warnings };

  const { fm, body } = epic;
  const id = fm.id ?? "(no id)";

  if (!STATUSES.has(String(fm.status)))
    problems.push(`status "${fm.status}" is not a known status`);
  if (!SIZES.has(String(fm.size)))
    problems.push(
      `size must be S or M (L does not exist — split into epics with depends_on), got "${fm.size}"`,
    );
  if (!String(fm.title ?? "").trim()) problems.push("title is empty");

  const goal = section(body, "Цель").trim();
  if (!goal) problems.push("## Цель is empty");

  const criteria = parseCriteria(section(body, "Критерии приёмки"));
  const isWhenThen = (c) => /КОГДА[\s\S]*ТО\s/u.test(c);
  const whenThen = criteria.filter(isWhenThen);
  if (whenThen.length === 0) {
    problems.push(
      "no acceptance criterion in «КОГДА …, ТО …» form (an observable outcome, not an implementation step)",
    );
  }
  // Requiring only "at least one" lets an epic with seven good criteria and one
  // "сделать раннер" pass silently — and that one is an implementation step, which is
  // exactly what the form exists to keep out. Name every offender rather than one.
  for (const c of criteria.filter((x) => !isWhenThen(x))) {
    warnings.push(
      `criterion is not in «КОГДА …, ТО …» form (reads as an implementation step): "${c.slice(0, 70)}${c.length > 70 ? "…" : ""}"`,
    );
  }

  const verification = section(body, "Верификация");
  if (!/```[\s\S]*?```/.test(verification))
    problems.push("## Верификация has no fenced command block");

  const scopePaths = [...section(body, "Объём").matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  if (scopePaths.length === 0) problems.push("## Объём names no path");

  const known = new Set(loadEpics().map((e) => String(e.fm?.id)));
  for (const dep of toArray(fm.depends_on)) {
    if (!known.has(dep)) problems.push(`depends_on "${dep}" does not exist`);
  }
  for (const label of toArray(fm.serialize)) {
    if (!(label in SERIALIZE_LABELS))
      problems.push(`serialize label "${label}" is not in the registry`);
  }

  // Warnings — they do not block promotion, but they are almost always a real signal.
  if (!AREAS.has(String(fm.area))) warnings.push(`area "${fm.area}" is not in the vocabulary`);
  if (fm.touches_output === true && fm.autonomy === "auto") {
    problems.push(
      "touches_output: true is incompatible with autonomy: auto — the output diff needs a human on review",
    );
  }
  if (fm.costs_llm === true && !/cost:report/.test(verification)) {
    warnings.push("costs_llm: true but ## Верификация never runs `pnpm cost:report`");
  }
  const risky = ["packages/telegram", "packages/db/prisma", "packages/llm/src/prompts"];
  if (fm.autonomy === "auto" && scopePaths.some((p) => risky.some((r) => p.startsWith(r)))) {
    warnings.push(
      "autonomy: auto over a risky area (telegram / prisma / prompts) — use plan-gated or paired",
    );
  }
  // Most-specific label wins. `profiles/schema.ts` matches both the exact `profile-schema`
  // hotspot and the `profiles/` directory prefix; demanding both labels would serialise
  // every profile edit against every schema edit for no reason.
  const declared = toArray(fm.serialize);
  for (const sp of scopePaths) {
    let bestLabel = null;
    let bestLen = -1;
    for (const [label, hotspots] of Object.entries(SERIALIZE_LABELS)) {
      for (const h of hotspots) {
        if (sp.startsWith(h) && h.length > bestLen) {
          bestLen = h.length;
          bestLabel = label;
        }
      }
    }
    if (bestLabel && !declared.includes(bestLabel)) {
      problems.push(
        `## Объём path "${sp}" is a "${bestLabel}" hotspot but that label is missing from serialize:`,
      );
    }
  }

  return { id, ok: problems.length === 0, problems, warnings };
}

const toArray = (v) => (Array.isArray(v) ? v : v === "" || v == null ? [] : [v]);

// ─────────────────────────── git ───────────────────────────

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const liveBranches = () =>
  new Set(
    (git(["branch", "--list", "agent/*", "--format=%(refname:short)"]) ?? "")
      .split("\n")
      .filter(Boolean),
  );

// ─────────────────────────── modes ───────────────────────────

function readiness(epics) {
  const heldLabels = new Map();
  for (const e of epics) {
    if (!e.fm || !HOLDS_SERIALIZE.has(String(e.fm.status))) continue;
    for (const l of toArray(e.fm.serialize)) heldLabels.set(l, String(e.fm.id));
  }
  const doneIds = new Set(
    epics.filter((e) => e.fm && e.fm.status === "done").map((e) => String(e.fm.id)),
  );

  return epics
    .filter((e) => e.fm && e.fm.status === "todo")
    .map((e) => {
      const blockers = [];
      for (const dep of toArray(e.fm.depends_on)) {
        if (!doneIds.has(dep)) blockers.push(`waits on ${dep}`);
      }
      for (const l of toArray(e.fm.serialize)) {
        if (heldLabels.has(l)) blockers.push(`label "${l}" held by ${heldLabels.get(l)}`);
      }
      return { epic: e, blockers };
    });
}

/** Greedy maximum independent set over serialize labels: the parallel-safe batch. */
function planBatch(epics) {
  const claimable = readiness(epics).filter((r) => r.blockers.length === 0);
  const prio = (e) => ({ P1: 0, P2: 1, P3: 2 })[String(e.fm.priority)] ?? 3;
  claimable.sort(
    (a, b) =>
      prio(a.epic) - prio(b.epic) || String(a.epic.fm.id).localeCompare(String(b.epic.fm.id)),
  );

  const taken = new Set();
  const batch = [];
  const deferred = [];
  const paired = [];
  let outputTaken = false;

  for (const { epic } of claimable) {
    // `paired` is never dispatched to a sub-agent (.claude/rules/backlog.md § autonomy).
    // Listing it in the parallel batch is how it gets handed to one by mistake.
    if (epic.fm.autonomy === "paired") {
      paired.push(epic);
      continue;
    }
    const labels = toArray(epic.fm.serialize);
    const clash = labels.find((l) => taken.has(l));
    if (clash) {
      deferred.push({ epic, reason: `label "${clash}" already in this batch` });
      continue;
    }
    // Not a git conflict — a measurability one: two output-changing epics in one batch
    // make it impossible to say whose diff improved the issue.
    if (epic.fm.touches_output === true) {
      if (outputTaken) {
        deferred.push({ epic, reason: "another touches_output epic is already in this batch" });
        continue;
      }
      outputTaken = true;
    }
    labels.forEach((l) => taken.add(l));
    batch.push(epic);
  }
  return { batch, deferred, paired };
}

function staleClaims(epics) {
  const branches = liveBranches();
  if (branches === null) return null;
  return epics.filter(
    (e) =>
      e.fm && e.fm.status === "in-progress" && e.fm.branch && !branches.has(String(e.fm.branch)),
  );
}

function nextId(epics) {
  const max = epics.reduce((acc, e) => {
    const n = /^E-(\d+)/.exec(String(e.fm?.id ?? ""))?.[1];
    return n ? Math.max(acc, Number(n)) : acc;
  }, 0);
  return `E-${String(max + 1).padStart(3, "0")}`;
}

/**
 * The registry in this file and the table in backlog.md are two copies of one fact.
 * This check is why they cannot drift apart silently.
 */
// A criterion may wrap across lines — «КОГДА …,» on one, «ТО …» on the next is the most
// natural way to write one, and Prettier will reflow long bullets there anyway. Matching
// line-by-line kept only the first half, so a well-formed criterion lost its «ТО» and was
// reported as an implementation step: the gate punishing correct markdown, which teaches
// authors to shorten criteria until they fit rather than to write better ones. Same class
// of defect as the frontmatter reflow that emptied E-001's serialize list.
export function parseCriteria(sectionText) {
  const out = [];
  let open = false;
  for (const line of String(sectionText).split(/\r?\n/)) {
    const m = /^\s*-\s+\[[ xX]\]\s+(.+)$/.exec(line);
    if (m) {
      out.push(m[1].trim());
      open = true;
      continue;
    }
    if (line.trim() === "" || /^\s*[-*]\s/.test(line) || /^\S/.test(line)) {
      open = false;
      continue;
    }
    if (open && out.length) out[out.length - 1] += " " + line.trim();
  }
  return out;
}

function selfTest() {
  const doc = readFileSync(join(ROOT, ".claude", "rules", "backlog.md"), "utf8");
  const documented = new Set([...doc.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]));
  const coded = new Set(Object.keys(SERIALIZE_LABELS));
  const missing = [...coded].filter((l) => !documented.has(l));
  const extra = [...documented].filter((l) => !coded.has(l));

  // The rubric is only as good as its parser. This case was red before 2026-08-29: the
  // wrapped criterion came back as "КОГДА агент пишет мимо," with the «ТО» half dropped.
  const parsed = parseCriteria(
    ["- [ ] КОГДА агент пишет мимо,", "      ТО команда отклоняется.", "- [ ] сделать раннер"].join(
      "\n",
    ),
  );
  const parserOk =
    parsed.length === 2 && /ТО\s/u.test(parsed[0]) && !/ТО\s/u.test(parsed[1]);

  return {
    ok: missing.length === 0 && extra.length === 0 && parserOk,
    missing,
    extra,
    parserOk,
  };
}

// ─────────────────────────── cli ───────────────────────────

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const asJson = has("--json");

function main() {
  const epics = loadEpics();

  if (has("--selftest")) {
    const r = selfTest();
    console.log(
      r.ok
        ? "selftest ok: serialize registry matches backlog.md; criterion parser handles wrapped lines"
        : `selftest FAILED\n  in code, undocumented: ${r.missing.join(", ") || "-"}\n  documented, not in code: ${r.extra.join(", ") || "-"}\n  wrapped-criterion parser: ${r.parserOk ? "ok" : "BROKEN — a multi-line КОГДА/ТО criterion loses its ТО half"}`,
    );
    process.exit(r.ok ? 0 : 1);
  }

  if (has("--next-id")) {
    console.log(nextId(epics));
    return;
  }

  // Runs in `pnpm verify`. An epic past draft has already cleared the rubric, so any
  // failure here means something corrupted it after the fact — a reformat, a bad merge,
  // a hand edit. E-001 silently lost all nine serialize labels to a Prettier reflow and
  // nothing noticed, because validation only ever ran when someone remembered to ask.
  if (has("--validate-queue")) {
    const queue = epics.filter((e) => e.fm && String(e.fm.status) !== "draft");
    let failed = 0;
    for (const e of queue) {
      const r = validateEpic(e);
      if (!r.ok) {
        failed++;
        console.log(`FAIL  ${e.file}  (${r.id})`);
        r.problems.forEach((x) => console.log(`        ✗ ${x}`));
      }
      // Warnings do not fail the gate, but they must be visible. A weakened criterion
      // ("коннектор работает" replacing a КОГДА/ТО outcome) cannot be caught by a rubric
      // that never saw the original — that is /epic-review's job, against merge-base.
      // What the rubric CAN say is that the criterion is no longer an observable outcome,
      // and swallowing that leaves the only available signal unprinted.
      r.warnings.forEach((x) => console.log(`WARN  ${e.file}: ${x}`));
    }
    if (failed === 0)
      console.log(`epic queue ok: ${queue.length} non-draft epic(s) still satisfy the rubric`);
    process.exit(failed > 0 ? 1 : 0);
  }

  if (has("--validate")) {
    const files = argv.slice(argv.indexOf("--validate") + 1).filter((a) => !a.startsWith("--"));
    const targets = files.length
      ? files
      : epics.filter((e) => e.fm?.status === "draft").map((e) => e.path);
    if (targets.length === 0) {
      console.log("nothing to validate (no files given and no drafts in the queue)");
      return;
    }
    let failed = 0;
    for (const f of targets) {
      const r = validateEpic(parseEpic(resolve(f)));
      if (!r.ok) failed++;
      console.log(`${r.ok ? "OK  " : "FAIL"}  ${basename(f)}${r.id ? `  (${r.id})` : ""}`);
      r.problems.forEach((p) => console.log(`        ✗ ${p}`));
      r.warnings.forEach((w) => console.log(`        ! ${w}`));
    }
    process.exit(failed > 0 ? 1 : 0);
  }

  if (has("--stale")) {
    const stale = staleClaims(epics);
    if (stale === null) {
      console.error("could not list git branches — refusing to guess which claims are stale");
      process.exit(3);
    }
    if (asJson)
      console.log(
        JSON.stringify(
          stale.map((e) => e.fm),
          null,
          2,
        ),
      );
    else if (stale.length === 0) console.log("no stale claims");
    else
      stale.forEach((e) =>
        console.log(
          `${e.fm.id}  claimed_by ${e.fm.claimed_by} — branch "${e.fm.branch}" no longer exists`,
        ),
      );
    process.exit(stale.length ? 2 : 0);
  }

  if (has("--plan")) {
    const { batch, deferred, paired } = planBatch(epics);
    if (asJson) {
      console.log(
        JSON.stringify(
          {
            batch: batch.map((e) => e.fm),
            deferred: deferred.map((d) => ({ ...d.epic.fm, reason: d.reason })),
            paired: paired.map((e) => e.fm),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`parallel-safe batch (${batch.length}):`);
    batch.forEach((e) =>
      console.log(
        `  ${e.fm.id}  [${e.fm.priority}/${e.fm.size}/${e.fm.autonomy}]  ${e.fm.title}${toArray(e.fm.serialize).length ? `  serialize=${toArray(e.fm.serialize).join(",")}` : ""}`,
      ),
    );
    if (batch.length === 0) console.log("  (none)");
    if (deferred.length) {
      console.log(`\ndeferred to a later batch (${deferred.length}):`);
      deferred.forEach((d) =>
        console.log(`  ${d.epic.fm.id}  ${d.epic.fm.title}\n        → ${d.reason}`),
      );
    }
    if (paired.length) {
      console.log(
        `\nnot dispatchable — autonomy: paired, work these interactively (${paired.length}):`,
      );
      paired.forEach((e) => console.log(`  ${e.fm.id}  ${e.fm.title}`));
    }
    const live = liveBranches();
    if (live && live.size) console.log(`\nlive agent branches: ${[...live].join(", ")}`);
    console.log(
      "\nConflicts outside the registry cannot be predicted here — the rebase-clean gate in /finish-branch catches those.",
    );
    return;
  }

  if (has("--ready")) {
    const rows = readiness(epics);
    const ready = rows.filter((r) => r.blockers.length === 0);
    if (asJson) {
      console.log(
        JSON.stringify(
          ready.map((r) => r.epic.fm),
          null,
          2,
        ),
      );
      return;
    }
    console.log(`ready to claim (${ready.length}):`);
    ready.forEach((r) =>
      console.log(
        `  ${r.epic.fm.id}  [${r.epic.fm.priority}/${r.epic.fm.size}/${r.epic.fm.autonomy}]  ${r.epic.fm.title}`,
      ),
    );
    if (ready.length === 0) console.log("  (none)");
    const blocked = rows.filter((r) => r.blockers.length > 0);
    if (blocked.length) {
      console.log(`\nblocked (${blocked.length}):`);
      blocked.forEach((r) =>
        console.log(`  ${r.epic.fm.id}  ${r.epic.fm.title}\n        → ${r.blockers.join("; ")}`),
      );
    }
    console.log(
      "\nBefore fanning out several agents use --plan, not --ready: two ready epics can still share a serialize label.",
    );
    return;
  }

  // default: everything by status
  if (asJson) {
    console.log(
      JSON.stringify(
        epics.map((e) => e.fm ?? { file: e.file, error: e.error }),
        null,
        2,
      ),
    );
    return;
  }
  const broken = epics.filter((e) => e.error);
  broken.forEach((e) => console.log(`!! ${e.file}: ${e.error}`));
  const byStatus = new Map();
  for (const e of epics.filter((x) => x.fm)) {
    const s = String(e.fm.status);
    if (!byStatus.has(s)) byStatus.set(s, []);
    byStatus.get(s).push(e);
  }
  for (const s of ["in-progress", "review", "todo", "draft", "blocked", "done", "dropped"]) {
    const rows = byStatus.get(s);
    if (!rows?.length) continue;
    console.log(`\n${s} (${rows.length})`);
    rows.forEach((e) =>
      console.log(`  ${e.fm.id}  ${e.fm.title}${e.fm.branch ? `  → ${e.fm.branch}` : ""}`),
    );
  }
  const active = epics.filter((e) => e.fm && ACTIVE.has(String(e.fm.status))).length;
  if (active > 15)
    console.log(
      `\n! ${active} active epics (todo+in-progress+review). Above ~15 the queue stops being a queue.`,
    );
  if (epics.length === 0) console.log("no epics yet — create one from docs/epics/_template.md");
}

main();
