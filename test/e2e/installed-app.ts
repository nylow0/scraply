import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type LaunchEnvironment = NonNullable<NonNullable<Parameters<typeof _electron.launch>[0]>["env"]>;

interface InstalledAppOptions {
  directoryPrefix: string;
  profileDirectoryName?: string;
}

export function createInstalledApp(options: InstalledAppOptions) {
  const directory = mkdtempSync(join(tmpdir(), options.directoryPrefix));
  const userDataDirectory = options.profileDirectoryName
    ? join(directory, options.profileDirectoryName)
    : directory;
  let application: ElectronApplication | undefined;

  const close = async () => {
    const runningApplication = application;
    application = undefined;
    await runningApplication?.close();
  };

  return {
    directory,
    get application() {
      return application;
    },
    async launch(env: LaunchEnvironment) {
      if (application) throw new Error("The installed test application is already running");
      application = await _electron.launch({
        executablePath: process.env.SCRAPLY_E2E_EXECUTABLE
          ?? join(process.cwd(), "release", "win-unpacked", "Scraply.exe"),
        args: [`--user-data-dir=${userDataDirectory}`],
        env,
      });
      return application;
    },
    close,
    async cleanup(afterClose?: () => Promise<void>) {
      try {
        await close();
      } finally {
        try {
          await afterClose?.();
        } finally {
          await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }
    },
  };
}

// A signed-out profile gets the welcome sign-in prompt, which can open at any point during startup
// checks, including after a reload. Tests that don't exercise that prompt close it whenever it appears.
export async function dismissSignInPrompt(page: Page) {
  await page.addLocatorHandler(page.getByRole("dialog", { name: /^Welcome/ }), async (dialog) => {
    await dialog.getByRole("button", { name: "Not now" }).click();
  });
}
