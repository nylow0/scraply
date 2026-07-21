$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$setupPath = Join-Path $root "release\Scraply Setup 0.2.0.exe"
$installedExe = Join-Path $env:LOCALAPPDATA "Programs\Scraply\Scraply.exe"

if (-not (Test-Path $setupPath)) {
  throw "Installer not found: $setupPath. Run 'bun run package' first."
}

$process = Start-Process -FilePath $setupPath -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne $null -and $process.ExitCode -ne 0) {
  throw "Installer failed with exit code $($process.ExitCode)."
}

if (-not (Test-Path $installedExe)) {
  throw "Installed Scraply executable not found after install: $installedExe"
}

$item = Get-Item $installedExe
Write-Output "Updated installed Scraply: $($item.FullName)"
Write-Output "Last write time: $($item.LastWriteTime)"
