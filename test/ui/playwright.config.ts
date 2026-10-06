import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "ideas-cleanup.spec.ts",
  outputDir: "../../build/slice2-playwright",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5177", viewport: { width: 1440, height: 900 }, colorScheme: "dark", trace: "retain-on-failure" },
});
