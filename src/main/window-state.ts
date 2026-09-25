import { readFileSync } from "node:fs";
import type { BrowserWindow, Rectangle } from "electron";
import { z } from "zod";
import { writeFileAtomically } from "./atomic-file";

const WindowStateSchema = z.object({
  bounds: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  maximized: z.boolean(),
});

export type WindowState = z.infer<typeof WindowStateSchema>;

// A restored window must leave this much title bar on a display so it can still be dragged.
const REACHABLE_TITLE_BAR = { width: 100, height: 36 };

/**
 * Reads the placement saved by the previous session. Returns null for a first launch,
 * an unreadable file, or bounds that no longer reach any display (for example, after
 * unplugging a monitor), so the caller falls back to the default size.
 */
export function readWindowState(path: string, workAreas: Rectangle[]): WindowState | null {
  let state: WindowState;
  try {
    state = WindowStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
  const { x, y, width } = state.bounds;
  const reachable = workAreas.some(area =>
    Math.min(x + width, area.x + area.width) - Math.max(x, area.x) >= REACHABLE_TITLE_BAR.width
    && Math.min(y + REACHABLE_TITLE_BAR.height, area.y + area.height) - Math.max(y, area.y) >= REACHABLE_TITLE_BAR.height);
  return reachable ? state : null;
}

/**
 * Records the window's normal (unmaximized) bounds and whether it is maximized. Full screen
 * reopens as maximized. Call on "close", before the window is destroyed. Windows can report
 * slightly different bounds after applying a saved placement. Keep the saved bounds only when
 * the window still has its initial normal bounds, so even a small user adjustment persists.
 */
export function saveWindowState(
  path: string,
  window: BrowserWindow,
  restoredBounds: Rectangle | undefined,
  initialNormalBounds: Rectangle,
): void {
  const current = window.getNormalBounds();
  const unchanged = restoredBounds !== undefined && (["x", "y", "width", "height"] as const)
    .every(key => current[key] === initialNormalBounds[key]);
  const state: WindowState = {
    bounds: unchanged ? restoredBounds : current,
    maximized: window.isMaximized() || window.isFullScreen(),
  };
  writeFileAtomically(path, Buffer.from(JSON.stringify(state)));
}
