$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $root "package.json"
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
$setupPath = Join-Path $root "release\Scraply Setup $($package.version).exe"
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
