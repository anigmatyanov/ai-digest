// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "runs/**",
      "fixtures/**",
      "golden/**",
      "**/*.tsbuildinfo",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Explicit lint-only project rather than projectService: the build configs
        // exclude *.test.ts (tests must not land in dist), so the service cannot
        // resolve a project for them and typed linting silently drops the tests.
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // Named exports only. Next.js pages/layouts are exempted below.
      "no-restricted-exports": [
        "error",
        { restrictDefaultExports: { direct: true, named: true, defaultFrom: true } },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // A floating promise in a pipeline stage loses the error and the run reports success.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },

  // env is read in exactly one place, through a zod schema (CLAUDE.md § conventions).
  {
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["packages/core/src/env.ts", "**/*.config.*", "scripts/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read env only through packages/core/src/env.ts (zod-validated). See .claude/rules/pipeline.md.",
        },
      ],
    },
  },

  // Tooling requires a default export from its own config files.
  {
    files: ["*.config.{js,ts,mjs}", "eslint.config.js", "**/*.config.{js,ts,mjs}"],
    rules: { "no-restricted-exports": "off" },
  },

  // Next.js requires default exports for pages, layouts and route segment config.
  {
    files: ["apps/web/**/page.tsx", "apps/web/**/layout.tsx", "apps/web/**/route.ts"],
    rules: { "no-restricted-exports": "off" },
  },

  // Config files and standalone scripts are not part of a tsconfig project.
  {
    files: ["**/*.config.{js,ts,mjs}", "scripts/**/*.{js,mjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
);
