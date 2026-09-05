[CmdletBinding()]
param(
    [int] $MaximumLines = 6000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$sourceFiles = Get-ChildItem (Join-Path $repositoryRoot "crates") -Recurse -Filter "*.rs" |
    Where-Object {
        $_.FullName.Contains("$([IO.Path]::DirectorySeparatorChar)src$([IO.Path]::DirectorySeparatorChar)") -and
        $_.Name -ne "tests.rs"
    }

function Get-BraceDelta {
    param([AllowEmptyString()] [string] $Line)

    $openCount = ([regex]::Matches($Line, "\{")).Count
    $closeCount = ([regex]::Matches($Line, "\}")).Count
    return $openCount - $closeCount
}

$productionLines = 0
foreach ($sourceFile in $sourceFiles) {
    $skipConfiguredItem = $false
    $waitingForConfiguredItem = $false
    $configuredItemDepth = 0

    foreach ($line in Get-Content -LiteralPath $sourceFile.FullName) {
        $trimmed = $line.Trim()

        if (-not $skipConfiguredItem -and
            ($trimmed -eq "#[cfg(test)]" -or $trimmed -eq "#[cfg(debug_assertions)]")) {
            $skipConfiguredItem = $true
            $waitingForConfiguredItem = $true
            continue
        }

        if ($skipConfiguredItem) {
            if ($waitingForConfiguredItem -and $trimmed.StartsWith("#[")) {
                continue
            }

            $delta = Get-BraceDelta $line
            if ($waitingForConfiguredItem) {
                if ($line.Contains("{")) {
                    $waitingForConfiguredItem = $false
                    $configuredItemDepth = $delta
                    if ($configuredItemDepth -le 0) {
                        $skipConfiguredItem = $false
                    }
                }
                elseif (-not [string]::IsNullOrWhiteSpace($trimmed)) {
                    $skipConfiguredItem = $false
                }
                continue
            }

            $configuredItemDepth += $delta
            if ($configuredItemDepth -le 0) {
                $skipConfiguredItem = $false
            }
            continue
        }

        if (-not [string]::IsNullOrWhiteSpace($trimmed) -and
            -not $trimmed.StartsWith("//")) {
            $productionLines++
        }
    }
}

Write-Output "Production Rust line budget: $productionLines / $MaximumLines"
if ($productionLines -gt $MaximumLines) {
    throw "Production Rust source exceeds the $MaximumLines line budget."
}
