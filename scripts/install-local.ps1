$ErrorActionPreference = "Stop"

# CI runners export PowerShell 7 module paths that break module autoloading in
# Windows PowerShell 5.1; resetting the variable restores the 5.1 defaults.
$env:PSModulePath = "$PSHOME\Modules;$env:ProgramFiles\WindowsPowerShell\Modules;$env:windir\System32\WindowsPowerShell\v1.0\Modules"

$root = Split-Path -Parent $PSScriptRoot
$packagePath = Join-Path $root "package.json"
$manifestPath = Join-Path $root "release\manifest.json"
$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
$setupPath = Join-Path $root "release\Scraply Setup $($package.version).exe"
$installedDir = Join-Path $env:LOCALAPPDATA "Programs\Scraply"
$installedExe = Join-Path $installedDir "Scraply.exe"
$installedAsar = Join-Path $installedDir "resources\app.asar"
$installedResourcesDir = Join-Path $installedDir "resources"

if (-not (Test-Path $setupPath)) {
  throw "Installer not found: $setupPath. Run 'bun run package' first."
}
if (-not (Test-Path $manifestPath)) {
  throw "Release manifest not found: $manifestPath. Run 'bun run package' first."
}

$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.schemaVersion -ne 2) {
  throw "Unsupported release manifest schema version: $($manifest.schemaVersion)."
}
if ($manifest.appVersion -ne $package.version) {
  throw "Manifest version $($manifest.appVersion) does not match package version $($package.version)."
}

$expectedInstallers = @($manifest.artifacts | Where-Object { $_.name -eq "installer" })
if ($expectedInstallers.Count -ne 1) {
  throw "Release manifest must contain exactly one installer artifact."
}
$expectedInstaller = $expectedInstallers[0]
if ((Split-Path $expectedInstaller.path -Leaf) -ne (Split-Path $setupPath -Leaf)) {
  throw "Release manifest installer filename does not match the setup executable."
}
$setupItem = Get-Item -LiteralPath $setupPath
$setupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $setupPath).Hash.ToLowerInvariant()
if ($setupItem.Length -ne $expectedInstaller.bytes -or $setupHash -ne $expectedInstaller.sha256) {
  throw "Installer size or SHA-256 does not match the release manifest."
}

$process = Start-Process -FilePath $setupPath -ArgumentList "/S" -Wait -PassThru -WindowStyle Hidden
if ($process.ExitCode -ne $null -and $process.ExitCode -ne 0) {
  throw "Installer failed with exit code $($process.ExitCode)."
}

if (-not (Test-Path $installedExe)) {
  throw "Installed Scraply executable not found after install: $installedExe"
}
if (-not (Test-Path $installedAsar)) {
  throw "Installed Scraply app.asar not found after install: $installedAsar"
}

$version = (Get-Item -LiteralPath $installedExe).VersionInfo
if ($version.ProductName -ne "Scraply" -or $version.FileVersion -ne $package.version -or -not $version.ProductVersion.StartsWith($package.version)) {
  throw "Installed executable metadata does not match Scraply $($package.version)."
}

$expectedExe = $manifest.artifacts | Where-Object { $_.name -eq "unpacked" }
$expectedAsar = $manifest.artifacts | Where-Object { $_.name -eq "app-asar" }
if ($null -eq $expectedExe -or $null -eq $expectedAsar) {
  throw "Release manifest is missing unpacked executable or app.asar metadata."
}

$installedExeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedExe).Hash.ToLowerInvariant()
$installedAsarHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $installedAsar).Hash.ToLowerInvariant()
if ($installedExeHash -ne $expectedExe.sha256) {
  throw "Installed executable hash does not match the packaged executable."
}
if ($installedAsarHash -ne $expectedAsar.sha256) {
  throw "Installed app.asar hash does not match the packaged app.asar."
}

if ($null -eq $manifest.runtime) {
  throw "Release manifest is missing bundled runtime metadata."
}

function Resolve-RuntimeFile {
  param(
    [Parameter(Mandatory)] [string] $RelativePath
  )

  if ($RelativePath -notmatch '^runtime/[A-Za-z0-9._-]+$') {
    throw "Unsafe runtime resource path in release manifest: $RelativePath"
  }
  $runtimeRoot = [IO.Path]::GetFullPath((Join-Path $installedResourcesDir "runtime"))
  $resolved = [IO.Path]::GetFullPath((Join-Path $installedResourcesDir $RelativePath.Replace('/', '\')))
  $runtimePrefix = $runtimeRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolved.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Runtime resource resolves outside the installed runtime directory: $RelativePath"
  }
  return $resolved
}

function Assert-RuntimeFile {
  param(
    [Parameter(Mandatory)] $Record,
    [Parameter(Mandatory)] [string] $Description
  )

  $path = Resolve-RuntimeFile -RelativePath ([string]$Record.path)
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "$Description not found after install: $path"
  }
  $item = Get-Item -LiteralPath $path
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
  if ($item.Length -ne $Record.bytes -or $hash -ne $Record.sha256) {
    throw "$Description size or SHA-256 does not match the release manifest."
  }
  return $path
}

$runtime = $manifest.runtime
$runtimeExe = Assert-RuntimeFile -Record $runtime.executable -Description "Installed runtime executable"
$runtimeLockPath = Assert-RuntimeFile -Record $runtime.lock -Description "Installed runtime lock"
$null = Assert-RuntimeFile -Record $runtime.checksums -Description "Installed runtime checksums"
foreach ($notice in @($runtime.notices)) {
  $null = Assert-RuntimeFile -Record $notice -Description "Installed runtime notice"
}

$runtimeFiles = @(Get-ChildItem -LiteralPath (Join-Path $installedResourcesDir "runtime") -File |
  Select-Object -ExpandProperty Name |
  Sort-Object)
$expectedRuntimeFiles = @(
  "LICENSE",
  "OPENAI-NOTICE",
  "SHA256SUMS.txt",
  "UPSTREAM.md",
  "scraply-agent.exe",
  "scraply-agent.lock.json"
) | Sort-Object
if (($runtimeFiles -join "`n") -ne ($expectedRuntimeFiles -join "`n")) {
  throw "Installed runtime directory contains unexpected files: $($runtimeFiles -join ', ')"
}

$runtimeLock = Get-Content -Raw -LiteralPath $runtimeLockPath | ConvertFrom-Json
if ($runtimeLock.schemaVersion -ne 1 -or
    $runtimeLock.platform -ne "windows-x64" -or
    $runtimeLock.executable -ne "scraply-agent.exe" -or
    $runtimeLock.version -ne $runtime.version -or
    $runtimeLock.sourceCommit -ne $runtime.sourceCommit -or
    $runtimeLock.sha256 -ne $runtime.executable.sha256 -or
    $runtimeLock.sizeBytes -ne $runtime.executable.bytes -or
    (@($runtimeLock.protocolVersions) -join ",") -ne "1.1") {
  throw "Installed runtime lock does not match the release manifest or required native protocol 1.1."
}

$runtimeVersion = (& $runtimeExe --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne $runtime.executable.versionOutput) {
  throw "Installed runtime version check failed. Expected '$($runtime.executable.versionOutput)', got '$runtimeVersion'."
}
$runtimeSignature = (Get-AuthenticodeSignature -LiteralPath $runtimeExe).Status.ToString()
if ($runtimeSignature -ne $runtime.executable.signatureStatus) {
  throw "Installed runtime signature status changed from $($runtime.executable.signatureStatus) to $runtimeSignature."
}

Write-Output "Updated installed Scraply: $installedExe"
Write-Output "Version: $($version.ProductVersion)"
Write-Output "Source SHA: $($manifest.sourceSha)"
Write-Output "Source state: $(if ($manifest.dirty) { 'dirty local build' } else { 'clean release build' })"
Write-Output "Installed executable SHA-256: $installedExeHash"
Write-Output "Runtime: $runtimeVersion ($($runtime.sourceCommit))"
Write-Output "Runtime SHA-256: $($runtime.executable.sha256)"
