import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

export default defineConfig({
  root: resolve("test/ui"),
  plugins: [svelte(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5176, strictPort: true, open: false,
    // Worktrees can use hoisted dependencies; Vite must serve the resolved font files.
    fs: { allow: [resolve("."), dirname(createRequire(import.meta.url).resolve("@fontsource-variable/plus-jakarta-sans"))] },
  },
});
