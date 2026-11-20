import tseslint from "typescript-eslint";

export default [
  { ignores: [".worktrees/**", "build/**", "node_modules/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  ...tseslint.configs.recommended,
];
