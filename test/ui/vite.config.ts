import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve("test/ui"),
  plugins: [svelte(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5176, strictPort: true, open: false },
});
