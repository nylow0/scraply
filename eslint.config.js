import tseslint from "typescript-eslint";

export default [
  { ignores: [".worktrees/**", "build/**", "node_modules/**", "runtime/vendor/**", "runtime/target/**", "runtime/dist/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  ...tseslint.configs.recommended,
  {
    files: ["src/db/sqlite.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
];
