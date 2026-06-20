import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    trace: "retain-on-failure",
  },
});
