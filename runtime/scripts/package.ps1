[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw "Packaging is supported only on Windows."
}
if (-not [Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
    throw "Run this script from an x64 PowerShell process on Windows x64."
}

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$workspaceTarget = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "target"))
$workspaceTargetExisted = Test-Path -LiteralPath $workspaceTarget
$priorCargoTargetDirectory = [Environment]::GetEnvironmentVariable("CARGO_TARGET_DIR", "Process")
$ownsCargoTargetDirectory = [string]::IsNullOrWhiteSpace($priorCargoTargetDirectory)
if ($ownsCargoTargetDirectory) {
    $cargoTargetDirectory = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "..\build\cargo"))
}
elseif ([IO.Path]::IsPathRooted($priorCargoTargetDirectory)) {
    $cargoTargetDirectory = [IO.Path]::GetFullPath($priorCargoTargetDirectory)
}
else {
    $cargoTargetDirectory = [IO.Path]::GetFullPath((
        Join-Path $repositoryRoot $priorCargoTargetDirectory
    ))
}

$repositoryPrefix = $repositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) +
    [IO.Path]::DirectorySeparatorChar
if ($cargoTargetDirectory.Equals($repositoryRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $cargoTargetDirectory.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "CARGO_TARGET_DIR must resolve outside the repository: $cargoTargetDirectory"
}
[Environment]::SetEnvironmentVariable("CARGO_TARGET_DIR", $cargoTargetDirectory, "Process")
Write-Verbose "Using external Cargo target directory: $cargoTargetDirectory"

try {
$cargo = (Get-Command cargo -ErrorAction Stop).Source
$toolchain = "stable-x86_64-pc-windows-msvc"
$targetTriple = "x86_64-pc-windows-msvc"
$localPackages = @(
    "scraply-agent",
    "scraply-agent-core",
    "scraply-agent-providers"
)

function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string] $Program,
        [Parameter(Mandatory)] [string[]] $Arguments,
        [Parameter(Mandatory)] [string] $Description
    )
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

    Push-Location $repositoryRoot
    try {
        $formatArguments = @("+$toolchain", "fmt", "--check")
        foreach ($package in $localPackages) {
            $formatArguments += @("-p", $package)
        }
        Invoke-Checked $cargo $formatArguments "local Rust formatting check"

        & (Join-Path $PSScriptRoot "check-source-budget.ps1") -MaximumLines 6000

    Invoke-Checked $cargo @(
        "+$toolchain", "test", "--workspace", "--locked", "--target", $targetTriple
    ) "locked MSVC test suite"

    Invoke-Checked $cargo @(
        "+$toolchain", "clippy", "--workspace", "--all-targets", "--locked",
        "--target", $targetTriple, "--", "-D", "warnings"
    ) "strict MSVC clippy"

    $metadataJson = & $cargo "+$toolchain" metadata --no-deps --format-version 1
    if ($LASTEXITCODE -ne 0) {
        throw "cargo metadata failed with exit code $LASTEXITCODE."
    }
    $metadata = $metadataJson | ConvertFrom-Json
        Invoke-Checked $cargo @(
            "+$toolchain", "build", "-p", "scraply-agent", "--release", "--locked",
            "--target", $targetTriple
        ) "locked MSVC release build"
    }
    finally {
        Pop-Location
    }

$cliPackages = @($metadata.packages | Where-Object { $_.name -eq "scraply-agent" })
if ($cliPackages.Count -ne 1) {
    throw "Expected exactly one scraply-agent package in Cargo metadata."
}

$version = [string]$cliPackages[0].version
$binaryPath = Join-Path ([string]$metadata.target_directory) "$targetTriple\release\scraply-agent.exe"
if (-not (Test-Path -LiteralPath $binaryPath -PathType Leaf)) {
    throw "Release binary was not produced at $binaryPath."
}

$binaryBytes = [IO.File]::ReadAllBytes($binaryPath)
$binaryText = [Text.Encoding]::ASCII.GetString($binaryBytes)
if ($binaryText.Contains("SCRAPLY_AGENT_TEST_FIXTURE") -or
    $binaryText.Contains("SCRAPLY_AGENT_TEST_BASE_URL")) {
    throw "A debug-only test seam is present in the release binary."
}
$releaseVersion = & $binaryPath --version
if ($LASTEXITCODE -ne 0 -or $releaseVersion -ne "scraply-agent $version") {
    throw "Release smoke test failed."
}
$binarySize = (Get-Item -LiteralPath $binaryPath).Length
if ($binarySize -gt 20MB) {
    throw "Installed runtime exceeds the 20 MiB release budget: $binarySize bytes."
}

$distRoot = [IO.Path]::GetFullPath((Join-Path $repositoryRoot "dist"))
$packageDirectory = [IO.Path]::GetFullPath((Join-Path $distRoot "scraply-agent-$version-windows-x64"))
$safePrefix = $distRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $packageDirectory.StartsWith($safePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to package outside the repository dist directory."
}

if (Test-Path -LiteralPath $packageDirectory) {
    Remove-Item -LiteralPath $packageDirectory -Recurse -Force
}
$null = New-Item -ItemType Directory -Path (Join-Path $packageDirectory "docs") -Force
$null = New-Item -ItemType Directory -Path (Join-Path $packageDirectory "docs\adr") -Force

$artifacts = @(
    @{ Source = $binaryPath; Relative = "scraply-agent.exe" },
    @{ Source = (Join-Path $repositoryRoot "LICENSE"); Relative = "LICENSE" },
    @{ Source = (Join-Path $repositoryRoot "vendor\openai-codex\NOTICE"); Relative = "OPENAI-NOTICE" },
    @{ Source = (Join-Path $repositoryRoot "UPSTREAM.md"); Relative = "UPSTREAM.md" },
    @{ Source = (Join-Path $repositoryRoot "README.md"); Relative = "README.md" },
    @{ Source = (Join-Path $repositoryRoot "CONTEXT.md"); Relative = "CONTEXT.md" },
    @{ Source = (Join-Path $repositoryRoot "docs\adr\0001-custom-runtime.md"); Relative = "docs\adr\0001-custom-runtime.md" },
    @{ Source = (Join-Path $repositoryRoot "docs\auth-architecture.md"); Relative = "docs\auth-architecture.md" },
    @{ Source = (Join-Path $repositoryRoot "docs\known-limitations.md"); Relative = "docs\known-limitations.md" }
)

foreach ($artifact in $artifacts) {
    if (-not (Test-Path -LiteralPath $artifact.Source -PathType Leaf)) {
        throw "Required package file is missing: $($artifact.Source)"
    }
    $destination = Join-Path $packageDirectory $artifact.Relative
    Copy-Item -LiteralPath $artifact.Source -Destination $destination
}

$checksumRelatives = @($artifacts | ForEach-Object { $_.Relative })
$checksumLines = foreach ($relativePath in ($checksumRelatives | Sort-Object)) {
    $packagedPath = Join-Path $packageDirectory $relativePath
    $hash = (Get-FileHash -LiteralPath $packagedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $relative = $relativePath.Replace("\", "/")
    "$hash  $relative"
}
[IO.File]::WriteAllLines(
    (Join-Path $packageDirectory "SHA256SUMS.txt"),
    [string[]]$checksumLines,
    [Text.Encoding]::ASCII
)

    Write-Output $packageDirectory
}
finally {
    [Environment]::SetEnvironmentVariable(
        "CARGO_TARGET_DIR",
        $priorCargoTargetDirectory,
        "Process"
    )

    if (-not $workspaceTargetExisted -and (Test-Path -LiteralPath $workspaceTarget)) {
        throw "Packaging unexpectedly created the workspace target directory: $workspaceTarget"
    }
}
