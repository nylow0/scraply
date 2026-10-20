import { win32 } from "node:path";
import { z } from "zod";

const pathValueSchema = z.object({
  value: z.string(),
  type: z.enum(["REG_SZ", "REG_EXPAND_SZ"]),
}).strict();

export type UserPathValue = z.infer<typeof pathValueSchema>;

/** Inject a registry for tests. The default implementation only touches HKCU Environment. */
export interface UserPathRegistry {
  readPath(): Promise<UserPathValue | null>;
  writePath(value: UserPathValue): Promise<void>;
  deletePath(): Promise<void>;
  broadcastEnvironmentChange(): Promise<void>;
}

export function parseSetupArguments(args: readonly string[]): { remove: boolean } {
  if (args.some((arg) => arg !== "--remove") || args.length > 1) {
    throw new Error("Usage: scraply setup [--remove]");
  }
  return { remove: args.includes("--remove") };
}

function comparablePath(value: string): string {
  const unquoted = value.trim().replace(/^"(.*)"$/, "$1");
  return win32.normalize(unquoted).replace(/[\\/]+$/, "").toLowerCase();
}

/** Preserve every unrelated PATH entry verbatim, including its order and registry type. */
export function updateUserPath(
  current: UserPathValue | null,
  directory: string,
  remove: boolean,
): { value: UserPathValue | null; changed: boolean } {
  if (!win32.isAbsolute(directory) || /[;\r\n\0"]/.test(directory)) {
    throw new Error("Setup requires an absolute executable directory without PATH separators.");
  }
  const entries = current?.value ? current.value.split(";") : [];
  const matching = entries.some((entry) => comparablePath(entry) === comparablePath(directory));
  if (matching !== remove) return { value: current, changed: false };
  const updated = remove
    ? entries.filter((entry) => comparablePath(entry) !== comparablePath(directory))
    : [...entries, directory];
  return {
    value: remove && updated.length === 0 ? null : { value: updated.join(";"), type: current?.type ?? "REG_EXPAND_SZ" },
    changed: true,
  };
}

// PowerShell ships with Windows. RegistryValueOptions avoids expanding %VARIABLES%,
// and SendMessageTimeout notifies Explorer without waiting on a hung window forever.
const registryScript = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.action -eq 'broadcast') {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ScraplyEnvironment {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
  $result = [UIntPtr]::Zero
  $sent = [ScraplyEnvironment]::SendMessageTimeout([IntPtr]65535, 26, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  if ($sent -eq [IntPtr]::Zero) { throw 'Environment notification failed. Open a new terminal to use the changed PATH.' }
} else {
  $writable = $request.action -ne 'read'
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $writable)
  if ($null -eq $key -and $request.action -eq 'write') { $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
  try {
    if ($request.action -eq 'read') {
      if ($null -eq $key -or $key.GetValueNames() -notcontains 'Path') { [Console]::Out.Write('null') }
      else {
        $kind = $key.GetValueKind('Path')
        if ($kind -eq [Microsoft.Win32.RegistryValueKind]::String) { $type = 'REG_SZ' }
        elseif ($kind -eq [Microsoft.Win32.RegistryValueKind]::ExpandString) { $type = 'REG_EXPAND_SZ' }
        else { throw 'User PATH has an unsupported registry type.' }
        $value = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        [Console]::Out.Write((@{value = $value; type = $type} | ConvertTo-Json -Compress))
      }
    } elseif ($request.action -eq 'write') {
      if ($request.value.type -eq 'REG_SZ') { $kind = [Microsoft.Win32.RegistryValueKind]::String }
      else { $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $key.SetValue('Path', [string]$request.value.value, $kind)
    } elseif ($request.action -eq 'delete') {
      if ($null -ne $key) { $key.DeleteValue('Path', $false) }
    } else { throw 'Unsupported registry operation.' }
  } finally { if ($null -ne $key) { $key.Dispose() } }
}
`;

async function registryOperation(action: "read" | "write" | "delete" | "broadcast", value?: UserPathValue): Promise<string> {
  if (process.platform !== "win32") throw new Error("scraply setup requires Windows.");
  const env: NodeJS.ProcessEnv = { ...process.env, EXA_API_KEY: "", PERPLEXITY_API_KEY: "" };
  delete env.PSModulePath;
  const child = Bun.spawn([
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(registryScript, "utf16le").toString("base64"),
  ], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  child.stdin.write(JSON.stringify({ action, value }));
  child.stdin.end();
  const [output, , exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(action === "broadcast"
      ? "User PATH changed, but Windows could not be notified. Open a new terminal."
      : `Could not ${action} the current user's PATH. No administrator access is required.`);
  }
  return output;
}

const windowsRegistry: UserPathRegistry = {
  async readPath() { return pathValueSchema.nullable().parse(JSON.parse(await registryOperation("read"))); },
  async writePath(value) { await registryOperation("write", pathValueSchema.parse(value)); },
  async deletePath() { await registryOperation("delete"); },
  async broadcastEnvironmentChange() { await registryOperation("broadcast"); },
};

/** Setup changes only PATH. It neither opens a profile nor starts the shared host. */
export async function setupCli(options: {
  remove?: boolean;
  executablePath?: string;
  registry?: UserPathRegistry;
} = {}) {
  const executable = options.executablePath ?? process.execPath;
  if (win32.basename(executable).toLowerCase() !== "scraply.exe") {
    throw new Error("Run setup from the extracted scraply.exe executable.");
  }
  const directory = win32.dirname(executable);
  const registry = options.registry ?? windowsRegistry;
  const current = await registry.readPath();
  const update = updateUserPath(current, directory, options.remove ?? false);
  if (update.changed) {
    if (update.value) await registry.writePath(update.value);
    else await registry.deletePath();
    await registry.broadcastEnvironmentChange();
  }
  return { changed: update.changed, removed: options.remove ?? false, directory, restartRequired: true as const };
}
