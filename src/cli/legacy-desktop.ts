import { dlopen, type Pointer } from "bun:ffi";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AppError } from "../shared/errors";

export type LegacyDesktopPresence = { running: false; pid: null } | { running: true; pid: number };

function directoryIdentity(path: string) {
  try {
    const canonical = realpathSync.native(path);
    const stat = statSync(canonical, { bigint: true });
    if (!stat.isDirectory()) throw new Error("Profile is not a directory");
    return { path: canonical.toLowerCase(), device: stat.dev, inode: stat.ino };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Check after acquiring the new owner lock, before opening SQLite or credentials. */
export function detectLegacyDesktop(profileDirectory: string): LegacyDesktopPresence {
  try {
    if (process.platform !== "win32" || process.arch !== "x64" || !profileDirectory || profileDirectory.includes("\0")) throw new Error("Unsupported profile");
    const profile = resolve(profileDirectory);
    const identity = directoryIdentity(profile);
    const kernel = dlopen("kernel32.dll", {
      SetLastError: { args: ["u32"], returns: "void" },
      GetLastError: { args: [], returns: "u32" },
    });
    try {
      const user = dlopen("user32.dll", {
        FindWindowExW: { args: ["i64", "ptr", "ptr", "ptr"], returns: "ptr" },
        GetWindowThreadProcessId: { args: ["ptr", "ptr"], returns: "u32" },
        GetWindowTextW: { args: ["ptr", "ptr", "i32"], returns: "i32" },
      });
      try {
        const className = Buffer.from("Chrome_MessageWindow\0", "utf16le");
        function find(previous: Pointer | null, title: Buffer | null) {
          kernel.symbols.SetLastError(0);
          // HWND_MESSAGE is -3. The Chromium singleton uses a message-only window.
          const handle = user.symbols.FindWindowExW(-3n, previous, className, title);
          if (!handle && kernel.symbols.GetLastError() !== 0) throw new Error("Window lookup failed");
          return handle;
        }
        function presence(handle: Pointer): LegacyDesktopPresence {
          const pid = new Uint32Array(1);
          if (!user.symbols.GetWindowThreadProcessId(handle, pid) || !pid[0]) throw new Error("Window process lookup failed");
          return { running: true, pid: pid[0] };
        }
        const exact = find(null, Buffer.from(`${profile}\0`, "utf16le"));
        if (exact) return presence(exact);
        if (!identity) return { running: false, pid: null };

        // Titles can use another spelling of the same directory, including a junction
        // or an 8.3 path. Read only singleton windows and compare filesystem identity.
        let previous: Pointer | null = null;
        for (let count = 0; count < 16384; count++) {
          const handle = find(previous, null);
          if (!handle) return { running: false, pid: null };
          previous = handle;
          const title = Buffer.alloc(65536);
          kernel.symbols.SetLastError(0);
          const length = user.symbols.GetWindowTextW(handle, title, title.length / 2);
          if (length === 0 && kernel.symbols.GetLastError() !== 0) throw new Error("Window title lookup failed");
          if (length >= title.length / 2 - 1) throw new Error("Window title is too long");
          const path = title.subarray(0, length * 2).toString("utf16le");
          if (!isAbsolute(path)) continue;
          const candidate = directoryIdentity(path);
          if (candidate && (candidate.path === identity.path ||
            (identity.inode !== 0n && candidate.device === identity.device && candidate.inode === identity.inode))) return presence(handle);
        }
        throw new Error("Too many singleton windows");
      } finally { user.close(); }
    } finally { kernel.close(); }
  } catch {
    throw new AppError("internal_error", "Could not determine whether a desktop app is using this profile. No profile data was opened.");
  }
}
