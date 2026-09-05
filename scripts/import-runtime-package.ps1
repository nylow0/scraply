[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string] $RuntimeRepository
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    -not [Environment]::Is64BitProcess) {
  throw "Runtime package import requires x64 Windows."
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$runtimeRoot = [IO.Path]::GetFullPath($RuntimeRepository)
$runtimeGit = Join-Path $runtimeRoot ".git"
if (-not (Test-Path -LiteralPath $runtimeGit)) {
  throw "Runtime repository not found: $runtimeRoot"
}

function Invoke-Git {
  param([Parameter(Mandatory)] [string[]] $Arguments)

  $output = & git -c "safe.directory=$($runtimeRoot.Replace('\', '/'))" -C $runtimeRoot @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
  return ($output | Out-String).Trim()
}

$sourceCommit = Invoke-Git -Arguments @("rev-parse", "HEAD")
if ($sourceCommit -notmatch '^[a-f0-9]{40}$') {
  throw "Runtime repository returned an invalid source commit: $sourceCommit"
}
$sourceState = Invoke-Git -Arguments @("status", "--porcelain", "--untracked-files=normal")
if (-not [string]::IsNullOrWhiteSpace($sourceState)) {
  throw "Runtime package import requires a clean runtime repository."
}

$packageScript = Join-Path $runtimeRoot "scripts\package.ps1"
if (-not (Test-Path -LiteralPath $packageScript -PathType Leaf)) {
  throw "Runtime package script not found: $packageScript"
}
$packageOutput = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $packageScript
if ($LASTEXITCODE -ne 0) {
  throw "Runtime packaging failed with exit code $LASTEXITCODE."
}
$sourceStateAfterPackage = Invoke-Git -Arguments @("status", "--porcelain", "--untracked-files=normal")
if (-not [string]::IsNullOrWhiteSpace($sourceStateAfterPackage)) {
  throw "Runtime packaging changed the runtime repository. Refusing to import an unpinned result."
}

$packageDirectory = @($packageOutput |
  Where-Object { $_ -is [string] -and (Test-Path -LiteralPath $_ -PathType Container) } |
  Select-Object -Last 1)
if ($packageDirectory.Count -ne 1) {
  throw "Runtime packaging did not report exactly one package directory."
}
$packageDirectory = [IO.Path]::GetFullPath([string]$packageDirectory[0])
$distRoot = [IO.Path]::GetFullPath((Join-Path $runtimeRoot "dist"))
$distPrefix = $distRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $packageDirectory.StartsWith($distPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Runtime package directory is outside the runtime dist directory: $packageDirectory"
}

$executablePath = Join-Path $packageDirectory "scraply-agent.exe"
$versionOutput = (& $executablePath --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch '^scraply-agent (\d+\.\d+\.\d+)$') {
  throw "Runtime package has invalid version output: $versionOutput"
}
$version = $Matches[1]
$expectedPackageName = "scraply-agent-$version-windows-x64"
if ((Split-Path $packageDirectory -Leaf) -ne $expectedPackageName) {
  throw "Runtime package directory name does not match version $version."
}

$requiredFiles = @("scraply-agent.exe", "LICENSE", "OPENAI-NOTICE", "UPSTREAM.md")
foreach ($name in $requiredFiles) {
  $path = Join-Path $packageDirectory $name
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Runtime package is missing required file: $path"
  }
}

$binaryBytes = [IO.File]::ReadAllBytes($executablePath)
$binaryText = [Text.Encoding]::ASCII.GetString($binaryBytes)
foreach ($marker in @("SCRAPLY_AGENT_TEST_FIXTURE", "SCRAPLY_AGENT_TEST_BASE_URL")) {
  if ($binaryText.Contains($marker)) {
    throw "Runtime package contains debug-only fixture marker $marker."
  }
}
if ($binaryBytes.Length -gt 20MB) {
  throw "Runtime executable exceeds the 20 MiB package limit."
}

$temporaryRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) (
  "scraply-runtime-import-" + [Guid]::NewGuid().ToString("N")
)))
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd(
  [IO.Path]::DirectorySeparatorChar
) + [IO.Path]::DirectorySeparatorChar
if (-not $temporaryRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create runtime import files outside the temporary directory."
}
$temporaryArchive = $null

try {
  $null = New-Item -ItemType Directory -Path $temporaryRoot
  foreach ($name in $requiredFiles) {
    Copy-Item -LiteralPath (Join-Path $packageDirectory $name) -Destination $temporaryRoot
  }

  $checksumLines = foreach ($name in ($requiredFiles | Sort-Object)) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $temporaryRoot $name)).Hash.ToLowerInvariant()
    "$hash  $name"
  }
  $checksumPath = Join-Path $temporaryRoot "SHA256SUMS.txt"
  [IO.File]::WriteAllText(
    $checksumPath,
    (($checksumLines -join "`n") + "`n"),
    [Text.Encoding]::ASCII
  )

  $shortSource = $sourceCommit.Substring(0, 12)
  $archiveName = "scraply-agent-$version-windows-x64-$shortSource.zip"
  $temporaryArchive = Join-Path ([IO.Path]::GetTempPath()) (
    "scraply-runtime-archive-" + [Guid]::NewGuid().ToString("N") + ".zip"
  )
  Compress-Archive -CompressionLevel Optimal -Path (Join-Path $temporaryRoot "*") -DestinationPath $temporaryArchive

  $artifactDirectory = Join-Path $root "runtime-artifacts"
  $null = New-Item -ItemType Directory -Force -Path $artifactDirectory
  $archivePath = Join-Path $artifactDirectory $archiveName
  if (Test-Path -LiteralPath $archivePath) {
    throw "Immutable runtime archive already exists: $archivePath"
  }
  Move-Item -LiteralPath $temporaryArchive -Destination $archivePath

  $notices = foreach ($name in @("LICENSE", "OPENAI-NOTICE", "UPSTREAM.md")) {
    $path = Join-Path $temporaryRoot $name
    [ordered]@{
      source = $name
      target = $name
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
      sizeBytes = (Get-Item -LiteralPath $path).Length
    }
  }
  $lock = [ordered]@{
    schemaVersion = 1
    platform = "windows-x64"
    executable = "scraply-agent.exe"
    version = $version
    protocolVersions = @("1.1")
    sourceRepository = "https://github.com/nylow0/scraply-agent"
    sourceCommit = $sourceCommit
    upstreamCommit = "8c68d4c87dc54d38861f5114e920c3de2efa5876"
    artifactPath = "scraply-agent.exe"
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $temporaryRoot "scraply-agent.exe")).Hash.ToLowerInvariant()
    sizeBytes = (Get-Item -LiteralPath (Join-Path $temporaryRoot "scraply-agent.exe")).Length
    archive = [ordered]@{
      fileName = $archiveName
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
      sizeBytes = (Get-Item -LiteralPath $archivePath).Length
    }
    notices = @($notices)
    checksums = [ordered]@{
      path = "SHA256SUMS.txt"
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $checksumPath).Hash.ToLowerInvariant()
      sizeBytes = (Get-Item -LiteralPath $checksumPath).Length
    }
  }
  $lockPath = Join-Path $artifactDirectory "scraply-agent.windows-x64.lock.json"
  $lockJson = ($lock | ConvertTo-Json -Depth 6) + "`n"
  [IO.File]::WriteAllText($lockPath, $lockJson, [Text.UTF8Encoding]::new($false))

  Write-Output "Imported $versionOutput from $sourceCommit."
  Write-Output "Archive: $archivePath"
  Write-Output "Lock: $lockPath"
}
finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    $resolvedCleanup = [IO.Path]::GetFullPath($temporaryRoot)
    if (-not $resolvedCleanup.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean unexpected runtime import path: $resolvedCleanup"
    }
    Remove-Item -LiteralPath $resolvedCleanup -Recurse -Force
  }
  if ($null -ne $temporaryArchive -and (Test-Path -LiteralPath $temporaryArchive)) {
    $resolvedArchiveCleanup = [IO.Path]::GetFullPath($temporaryArchive)
    if (-not $resolvedArchiveCleanup.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean unexpected runtime archive path: $resolvedArchiveCleanup"
    }
    Remove-Item -LiteralPath $resolvedArchiveCleanup -Force
  }
}
