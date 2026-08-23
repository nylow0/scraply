import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  resolve: { conditions: ["browser"] },
  test: {
    environment: "jsdom",
    include: ["test/renderer/**/*.test.ts"],
    restoreMocks: true,
    setupFiles: ["test/renderer/setup.ts"],
  },
});
