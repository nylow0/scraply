$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$InstalledExe = Join-Path $env:LOCALAPPDATA "Programs\Scraply\Scraply.exe"
$UnpackedExe = Join-Path $ProjectRoot "release\win-unpacked\Scraply.exe"
$IconPath = Join-Path $ProjectRoot "build\icon.png"

if (Test-Path $InstalledExe) {
  $ExePath = $InstalledExe
} elseif (Test-Path $UnpackedExe) {
  $ExePath = $UnpackedExe
} else {
  Write-Error "Scraply.exe not found. Run 'npm run package' or install 'release/Scraply Setup *.exe' first."
}

$StartMenu = [Environment]::GetFolderPath("Programs")
$ShortcutPath = Join-Path $StartMenu "Scraply.lnk"

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $ExePath
$Shortcut.WorkingDirectory = Split-Path $ExePath
$Shortcut.Description = "Local research and idea generation"
if (Test-Path $IconPath) {
  $Shortcut.IconLocation = "$IconPath,0"
}
$Shortcut.Save()

Write-Host "Start Menu shortcut created at: $ShortcutPath"
Write-Host "Shortcut target: $ExePath"
if (Test-Path $IconPath) {
  Write-Host "Shortcut icon: $IconPath"
}
Write-Host ""
Write-Host "Launch Scraply by searching 'Scraply' in the Windows Start menu."
Write-Host "First launch: enter OpenCode and Exa API keys to connect providers."
