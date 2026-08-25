/**
 * The only module that reads `process.env`. Enforced by ESLint
 * (`no-restricted-properties`), which is shown red on a violation in the bootstrap commit.
 *
 * Everything is optional here, and that is deliberate. A schema that demands
 * ANTHROPIC_API_KEY at import time makes `pnpm test` impossible without a live key, and a
 * schema that demands DATABASE_URL makes the golden run depend on a database it never
 * touches. Instead the shape is validated once, and each consumer states what it needs at
 * the point of use via `requireEnv` — so the failure names the variable, the reason, and
 * where to declare it, instead of surfacing as `undefined` three stages later.
 */

import { z } from "zod";
import { DigestError } from "./errors.js";

/**
 * A required variable was missing or malformed.
 *
 * Defined here rather than in errors.ts because errors.ts is outside this epic's file map
 * (see docs/epics/E-001, `serialize` carries no `core-errors` label). It still extends
 * DigestError, so the runner's branching on our own failures is unaffected.
 */
export class MissingEnvError extends DigestError {
  constructor(
    readonly key: string,
    reason: string,
  ) {
    super(
      `Environment variable ${key} ${reason}.\n` +
        `Declare it in .env (see .env.example) and in packages/core/src/env.ts.`,
    );
  }
}

/**
 * An optional variable, where an empty value means "not set".
 *
 * `.env` files are full of `FOO=` placeholders — our own .env.example ships
 * `YOUTUBE_API_KEY=""`. Without this coercion the whole environment fails to parse
 * because of a placeholder nobody has filled in yet, and the run dies before reaching the
 * stage that would have told you which variable it actually needed.
 */
const optionalVar = (extra?: (s: z.ZodString) => z.ZodString) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    (extra ? extra(z.string().trim()) : z.string().trim()).optional(),
  );

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Neon. Pooled for the app and the pipeline, direct for migrations — swapping them
  // makes `prisma migrate` behave unpredictably against the pooler.
  DATABASE_URL: optionalVar((v) => v.startsWith("postgres")),
  DATABASE_URL_UNPOOLED: optionalVar((v) => v.startsWith("postgres")),

  // A key that does not start with sk-ant- is a copy/paste accident, not a valid key.
  ANTHROPIC_API_KEY: optionalVar((v) => v.startsWith("sk-ant-")),

  TELEGRAM_BOT_TOKEN: optionalVar(),
  TELEGRAM_CHANNEL_ID: optionalVar(),
  TELEGRAM_OWNER_ID: optionalVar(),
  TELEGRAM_WEBHOOK_SECRET: optionalVar(),

  SITE_URL: optionalVar((v) => v.url()),
  REVALIDATE_SECRET: optionalVar(),

  GH_PAT: optionalVar(),
  YOUTUBE_API_KEY: optionalVar(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;
let envFileLoaded = false;

/**
 * Load `.env` into process.env once, if it exists.
 *
 * Done here because this is the only module allowed to touch process.env, and because a
 * secret belongs in a gitignored file rather than in a shell profile: a key exported from
 * ~/.zshrc leaks into every process on the machine and is invisible to anyone reading the
 * repository. Values already present in the environment WIN — an explicit export is a
 * deliberate override, and silently replacing it would make a debugging session baffling.
 */
export function loadEnvFile(path = ".env"): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  try {
    // Node's own loader: no dependency, and it does not overwrite existing variables.
    process.loadEnvFile(path);
  } catch {
    // Absent .env is the normal case in CI, where secrets arrive as real env vars.
  }
}

/** Parse and cache the environment. Malformed values fail here, not at first use. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (cached && source === process.env) return cached;
  if (source === process.env) loadEnvFile();
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const key = String(first?.path[0] ?? "<unknown>");
    throw new MissingEnvError(key, first?.message ?? "is invalid");
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

type RequiredKey = {
  [K in keyof Env]-?: undefined extends Env[K] ? K : never;
}[keyof Env];

/**
 * Read a variable that this code path genuinely needs.
 *
 * Call it where the value is used, not at module load: the fixtures-driven run needs no
 * database and no API key, and demanding them up front would make the offline gate
 * un-runnable — which is the fastest way to get an offline gate deleted.
 */
export function requireEnv<K extends RequiredKey>(key: K, env: Env = loadEnv()): string {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new MissingEnvError(key, "is required for this operation but is not set");
  }
  return value;
}

/** Reset the cache. Tests only — production reads the environment once, on purpose. */
export function resetEnvCache(): void {
  cached = undefined;
}
