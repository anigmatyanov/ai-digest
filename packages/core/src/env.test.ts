import { beforeEach, describe, expect, it } from "vitest";
import { EnvSchema, loadEnv, MissingEnvError, requireEnv, resetEnvCache } from "./env.js";

describe("env", () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it("should default NODE_ENV to development when it is absent", () => {
    expect(loadEnv({}).NODE_ENV).toBe("development");
  });

  it("should parse an empty environment, because a fixtures run needs nothing", () => {
    // The offline gate must be runnable with no secrets at all. A schema that rejects an
    // empty environment is the fastest way to get that gate deleted.
    expect(() => loadEnv({})).not.toThrow();
  });

  it("should reject an Anthropic key that is not a key", () => {
    // The literal prefix is written out rather than derived from the schema: a test that
    // asks the schema what it expects cannot fail when the schema is wrong.
    const result = EnvSchema.safeParse({ ANTHROPIC_API_KEY: "my-key" });
    expect(result.success).toBe(false);
  });

  it("should accept a well-formed Anthropic key", () => {
    expect(EnvSchema.safeParse({ ANTHROPIC_API_KEY: "sk-ant-abc123" }).success).toBe(true);
  });

  it("should reject a DATABASE_URL that is not a postgres URL", () => {
    expect(EnvSchema.safeParse({ DATABASE_URL: "mysql://host/db" }).success).toBe(false);
  });

  it("should name the variable when a required one is missing", () => {
    // The point of requireEnv is the message: `undefined` surfacing three stages later
    // is the failure mode it exists to prevent.
    expect(() => requireEnv("ANTHROPIC_API_KEY", loadEnv({}))).toThrow(MissingEnvError);
    expect(() => requireEnv("ANTHROPIC_API_KEY", loadEnv({}))).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("should return the value when a required variable is present", () => {
    const env = loadEnv({ ANTHROPIC_API_KEY: "sk-ant-abc123" });
    expect(requireEnv("ANTHROPIC_API_KEY", env)).toBe("sk-ant-abc123");
  });

  it("should treat an empty string as missing rather than as a value", () => {
    // `FOO=` in a .env file yields "", which is the shape that silently produces
    // "Bearer " in an Authorization header instead of an error.
    const env = loadEnv({ TELEGRAM_BOT_TOKEN: "" });
    expect(() => requireEnv("TELEGRAM_BOT_TOKEN", env)).toThrow(MissingEnvError);
  });
});
