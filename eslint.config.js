import svelte from "eslint-plugin-svelte";
import tseslint from "typescript-eslint";

export default [
  { ignores: [".svelte-kit/**", ".worktrees/**", "archive/**", "build/**", "node_modules/**", "out/**", "release/**", "test-results/**", "runtime/vendor/**", "runtime/target/**", "runtime/dist/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  ...tseslint.configs.recommended,
  ...svelte.configs["flat/recommended"],
  {
    files: ["**/*.svelte"],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ["src/db/sqlite.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];
