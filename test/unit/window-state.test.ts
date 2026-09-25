import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWindowState } from "../../src/main/window-state";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const directories: string[] = [];

function savedFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "scraply-window-state-"));
  directories.push(directory);
  const path = join(directory, "window-state.json");
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("saved window placement", () => {
  test("restores the previous placement when it is still on a display", () => {
    const state = { bounds: { x: 200, y: 100, width: 1400, height: 900 }, maximized: true };
    expect(readWindowState(savedFile(JSON.stringify(state)), [primary])).toEqual(state);
  });

  test("falls back to the default size when the saved display is gone", () => {
    // Saved on a second monitor to the right, which is no longer connected.
    const state = { bounds: { x: 2100, y: 100, width: 1400, height: 900 }, maximized: false };
    expect(readWindowState(savedFile(JSON.stringify(state)), [primary])).toBeNull();
  });

  test("falls back when the title bar is above the top of every display", () => {
    const state = { bounds: { x: 200, y: -500, width: 1400, height: 900 }, maximized: false };
    expect(readWindowState(savedFile(JSON.stringify(state)), [primary])).toBeNull();
  });

  test("ignores a missing or damaged file", () => {
    expect(readWindowState(join(tmpdir(), "scraply-missing-window-state.json"), [primary])).toBeNull();
    expect(readWindowState(savedFile("{\"bounds\":"), [primary])).toBeNull();
  });
});
