param(
  [ValidateSet("staged", "history")]
  [string]$Scope = "staged",
  [string]$Repository = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

# Pin both the release archive and extracted executable. The same version runs locally and in CI.
$version = "8.30.1"
$archiveName = "gitleaks_8.30.1_windows_x64.zip"
$archiveSha256 = "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e"
$exeSha256 = "17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c"
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
if (-not $localAppData) { $localAppData = [IO.Path]::GetTempPath() }
$toolRoot = Join-Path $localAppData "Scraply\tools\gitleaks\$version"
$exe = Join-Path $toolRoot "gitleaks.exe"

if (-not (Test-Path -LiteralPath $exe)) {
  New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
  $archive = Join-Path $toolRoot $archiveName
  Invoke-WebRequest -Uri "https://github.com/gitleaks/gitleaks/releases/download/v$version/$archiveName" -OutFile $archive -UseBasicParsing
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveSha256) {
    throw "Gitleaks release archive checksum mismatch."
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $toolRoot -Force
}
if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $exeSha256) {
  throw "Gitleaks executable checksum mismatch."
}
if ((& $exe version) -ne $version) { throw "Unexpected Gitleaks version." }

function Test-SensitivePath([string]$Path) {
  $name = ($Path -replace '\\', '/').ToLowerInvariant()
  if ($name -match '(^|/)\.env(\.|$)' -and $name -notmatch '(^|/)\.env\.example$') { return $true }
  if ($name -match '(^|/)(\.npmrc|\.pypirc|private-mapping\.json|review-packet\.json|review-template\.json)$') { return $true }
  if ($name -match '(^|/)(\.agents|\.cursor|\.codex-build|\.worktrees|\.scraply|exports|backups)/') { return $true }
  return $name -match '\.(pem|p12|pfx|key|db|sqlite|sqlite3)(-(wal|shm|journal))?$'
}

$blockedPaths = @()
if ($Scope -eq "staged") {
  $stagedPaths = @(& git -C $Repository diff --cached --name-only --diff-filter=ACMR)
  if ($LASTEXITCODE -ne 0) { throw "Could not list staged paths." }
  $blockedPaths = @($stagedPaths | Where-Object { Test-SensitivePath $_ })
  foreach ($path in $blockedPaths) { Write-Output "Blocked staged path: $path" }
}

$report = Join-Path ([IO.Path]::GetTempPath()) ("scraply-gitleaks-{0}-{1}.json" -f $Scope, [Guid]::NewGuid().ToString("N"))
$scanArgs = @("git", "--redact=100", "--report-format=json", "--report-path=$report", "--no-color")
if ($Scope -eq "staged") {
  $scanArgs += "--staged"
} else {
  $scanArgs += "--max-archive-depth=1"
  $scanArgs += "--log-opts=--all --full-history --reflog --no-renames"
}

Push-Location $Repository
try {
  $priorPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $exe @scanArgs . 2>&1 | Out-Null
    $scanExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $priorPreference
  }
} finally {
  Pop-Location
}

if ($scanExit -gt 1) { throw "Gitleaks scan failed with exit code $scanExit." }
$findings = @()
if (Test-Path -LiteralPath $report) {
  $findings = @(Get-Content -LiteralPath $report -Raw | ConvertFrom-Json | Where-Object { $_ })
}
foreach ($finding in $findings) {
  $revision = if ($finding.Commit) { $finding.Commit } else { "staged" }
  Write-Output "Gitleaks: rule=$($finding.RuleID) file=$($finding.File) revision=$revision fingerprint=$($finding.Fingerprint)"
}

if ($blockedPaths.Count -gt 0 -or $scanExit -eq 1) {
  Write-Output "Redacted scan report: $report"
  exit 1
}
Remove-Item -LiteralPath $report -ErrorAction SilentlyContinue
Write-Output "Secret scan passed ($Scope, Gitleaks $version)."
