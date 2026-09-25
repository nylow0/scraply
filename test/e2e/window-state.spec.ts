import { expect, test, _electron, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMockBackend } from "./mock-backend";

test("the window reopens maximized, or at the size it was closed at", async () => {
  const mock = await startMockBackend();
  const userDataDir = mkdtempSync(path.join(tmpdir(), "scraply-window-state-"));
  const launch = async () => {
    const electron = await _electron.launch({
      executablePath: process.env.SCRAPLY_E2E_EXECUTABLE ?? path.join(process.cwd(), "release/win-unpacked/Scraply.exe"),
      args: [`--user-data-dir=${userDataDir}`],
      env: { ...process.env, SCRAPLY_E2E: "1", SCRAPLY_E2E_BACKEND_URL: mock.url, SCRAPLY_E2E_BACKEND_TOKEN: mock.token },
    });
    await electron.firstWindow();
    return electron;
  };
  const placement = (electron: ElectronApplication) => electron.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    return { maximized: window.isMaximized(), visible: window.isVisible(), bounds: window.getNormalBounds() };
  });
  let electron: ElectronApplication | undefined = await launch();
  try {
    // First launch opens at the default size. Windows display scaling can round it by a few pixels.
    const first = await placement(electron);
    expect(first).toMatchObject({ maximized: false, visible: true });
    expect(Math.abs(first.bounds.width - 1280)).toBeLessThanOrEqual(4);
    expect(Math.abs(first.bounds.height - 860)).toBeLessThanOrEqual(4);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize());
    await expect.poll(async () => (await placement(electron!)).maximized).toBe(true);
    await electron.close();

    electron = await launch();
    expect(await placement(electron)).toMatchObject({ maximized: true, visible: true });
    await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.unmaximize();
      window.setBounds({ x: 120, y: 90, width: 1100, height: 720 });
    });
    await expect.poll(async () => Math.abs((await placement(electron!)).bounds.width - 1100)).toBeLessThanOrEqual(4);
    const resized = await placement(electron);
    await electron.close();

    const savedFile = () => JSON.parse(readFileSync(path.join(userDataDir, "window-state.json"), "utf8"));
    expect(savedFile()).toEqual({ maximized: false, bounds: resized.bounds });

    // Windows display scaling may shift a restored window by a pixel or two, but repeated
    // reopens must not accumulate it: the window would otherwise grow on every launch.
    electron = await launch();
    const reopened = await placement(electron);
    expect(reopened.maximized).toBe(false);
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(reopened.bounds[key] - resized.bounds[key])).toBeLessThanOrEqual(4);
    }
    await electron.close();
    electron = await launch();
    expect(await placement(electron)).toEqual(reopened);
    expect(savedFile()).toEqual({ maximized: false, bounds: resized.bounds });

    // A small deliberate change must not be mistaken for display scaling drift.
    await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const bounds = window.getNormalBounds();
      window.setBounds({ ...bounds, x: bounds.x + 3, width: bounds.width + 4 });
    });
    const adjusted = await placement(electron);
    await electron.close();
    expect(savedFile()).toEqual({ maximized: false, bounds: adjusted.bounds });
    electron = await launch();
    const adjustedReopen = await placement(electron);
    expect(Math.abs(adjustedReopen.bounds.x - adjusted.bounds.x)).toBeLessThanOrEqual(4);
    expect(Math.abs(adjustedReopen.bounds.width - adjusted.bounds.width)).toBeLessThanOrEqual(4);
  } finally {
    await electron?.close();
    await mock.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
