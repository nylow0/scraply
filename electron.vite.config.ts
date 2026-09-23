import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { BROWSER_DEV_ORIGIN, browserDevProxy } from "./scripts/browser-dev-proxy";

const browserDev = process.env.SCRAPLY_BROWSER_DEV === "1";

export default defineConfig(({ mode }) => ({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          backend: resolve("src/backend/index.ts"),
          ...(mode === "e2e" ? { "backend-e2e": resolve("test/e2e/backend-entry.ts") } : {}),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "index.js",
        },
      },
    },
  },
  renderer: {
    ...(browserDev ? {
      server: {
        host: "127.0.0.1",
        port: Number(new URL(BROWSER_DEV_ORIGIN).port),
        strictPort: true,
        open: false,
        cors: false,
        fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/build/browser-dev/**"] },
        proxy: {
          "/__scraply_dev": {
            target: `http://127.0.0.1:${process.env.SCRAPLY_BROWSER_PORT}`,
            rewrite: (path: string) => path.replace(/^\/__scraply_dev/, ""),
            headers: { authorization: `Bearer ${process.env.SCRAPLY_BROWSER_TOKEN}` },
          },
        },
      },
    } : {}),
    root: resolve("src/renderer"),
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve("src/renderer/index.html"),
      },
    },
    plugins: [tailwindcss(), svelte(), ...(browserDev ? [browserDevProxy()] : [])],
  },
}));
