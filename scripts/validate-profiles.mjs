#!/usr/bin/env node
/**
 * Validate every profile against the schema. Runs in `pnpm verify`.
 *
 * A profile is the one place a topic lives, and changing the schema invalidates all of
 * them at once. Without this gate that breakage surfaces during a scheduled run at 09:00
 * on a Thursday rather than on the pull request that caused it.
 */

import { readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "profiles", "dist");

if (!existsSync(DIST)) {
  console.error("profiles/dist is missing — run `pnpm build` first (profiles are compiled).");
  process.exit(1);
}

const { parseProfile } = await import(pathToFileURL(join(DIST, "schema.js")).href);

const files = readdirSync(DIST)
  .filter((f) => f.endsWith(".js") && f !== "schema.js")
  .sort();

let failed = 0;
for (const file of files) {
  const mod = await import(pathToFileURL(join(DIST, file)).href);
  // Named export, not default: the repo forbids default exports outside tool configs,
  // and `export const profile` says what the file is rather than relying on position.
  const profile = mod.profile;
  if (!profile) {
    console.log(`FAIL  ${file}: no \`profile\` export (expected \`export const profile = defineProfile({...})\`)`);
    failed++;
    continue;
  }
  try {
    const parsed = parseProfile(profile);
    const enabled = parsed.sources.filter((s) => s.enabled !== false).length;
    const channels = Object.keys(parsed.delivery).length;
    console.log(
      `OK    ${file}  slug=${parsed.slug}  sources=${enabled}/${parsed.sources.length}  ` +
        `channels=${channels}${channels === 0 ? " (render-only)" : ""}`,
    );
  } catch (error) {
    failed++;
    console.log(`FAIL  ${file}`);
    const issues = error?.issues ?? [];
    for (const i of issues.slice(0, 8)) {
      console.log(`        ✗ ${i.path.join(".") || "<root>"}: ${i.message}`);
    }
    if (issues.length === 0) console.log(`        ✗ ${error?.message ?? error}`);
  }
}

if (files.length === 0) {
  console.error("no profiles found in profiles/dist — that is almost certainly a build problem.");
  process.exit(1);
}

process.exit(failed > 0 ? 1 : 0);
