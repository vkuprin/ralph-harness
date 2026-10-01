import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// The bun scripts that carry no .ts extension. The TypeScript project does not
// see them, so they are parsed as TypeScript and linted without type information.
const SCRIPTS = ["bin/ralph", "tests/stub/claude", "tests/stub/gh"];

export default defineConfig(
  { ignores: ["template/", "assets/", ".changeset/"] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // A best-effort kill or cleanup swallows its error on purpose, and says why
      // above the try when the reason is not obvious.
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: SCRIPTS,
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parser: tseslint.parser },
    // What typescript-eslint turns off for .ts files, the compiler's checks.
    rules: tseslint.configs.eslintRecommended.rules,
  },
  {
    // end() returns never, which ESLint's code path analysis cannot see.
    files: ["tests/stub/claude"],
    rules: { "no-fallthrough": "off" },
  },
  prettier,
);
