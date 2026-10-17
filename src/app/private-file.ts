import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Create the file with its DACL already protected, before writing the token.
// chmod on Windows does not restrict other users. Never print PowerShell errors,
// because they can contain the current user's identity or profile paths.
const WINDOWS_PRIVATE_WRITE = `
$ErrorActionPreference = 'Stop'
$stream = $null
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ScraplyPrivateMove { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool MoveFileExW(string source, string target, uint flags); }'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  $acl.AddAccessRule($rule)
  $stream = [IO.File]::Create($env:SCRAPLY_PRIVATE_TEMP, 4096, [IO.FileOptions]::None, $acl)
  [Console]::OpenStandardInput().CopyTo($stream)
  $stream.Flush($true)
  $stream.Dispose()
  $stream = $null
  # MoveFileEx keeps the source DACL. File.Replace would retain a possibly public
  # target DACL and expose the new token before it could be restricted.
  if (-not [ScraplyPrivateMove]::MoveFileExW($env:SCRAPLY_PRIVATE_TEMP, $env:SCRAPLY_PRIVATE_TARGET, 9)) { exit 1 }
} catch { exit 1 } finally { if ($null -ne $stream) { $stream.Dispose() } }
`;

/** Atomically publish a token-bearing file readable only by the current user. */
export function writePrivateFileAtomically(path: string, contents: string | Uint8Array): void {
  const temporary = join(dirname(path), `.owner-${randomUUID()}.tmp`);
  try {
    if (process.platform === "win32") {
      const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(WINDOWS_PRIVATE_WRITE, "utf16le").toString("base64")], {
        env: { ...process.env, SCRAPLY_PRIVATE_TEMP: resolve(temporary), SCRAPLY_PRIVATE_TARGET: resolve(path) },
        input: contents, stdio: ["pipe", "ignore", "ignore"], windowsHide: true, timeout: 15_000,
      });
      if (child.error || child.status !== 0) throw new Error("Private file publication failed.");
    } else {
      const file = openSync(temporary, "wx", 0o600);
      try { writeFileSync(file, contents); fsyncSync(file); } finally { closeSync(file); }
      renameSync(temporary, path);
    }
  } catch {
    throw new Error("Private file publication failed.");
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Keep cleanup errors from disclosing profile paths. */ }
  }
}
