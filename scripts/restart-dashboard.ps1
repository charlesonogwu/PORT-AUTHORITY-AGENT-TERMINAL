# Stop the running portpilot dashboard server + any --app= chrome
# windows attached to it, then re-launch via the shortcut launcher.
#
# IMPORTANT: the dashboard server reads dist/src/ui/dashboard.js at
# startup, NOT src/ui/dashboard.ts. After editing the React UI you must:
#   1. npm run build:dashboard   (regenerates src/ui/dashboard.ts)
#   2. npm run build:server      (compiles TS to dist/)
#   3. this script                (kill + relaunch)
# Or just `npm run build` which does the first two together.

$ErrorActionPreference = "SilentlyContinue"

Write-Host "Closing dashboard chrome windows..."
$AppProfile = Join-Path $env:USERPROFILE ".portpilot\dashboard-app-profile"
$chromes = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains("--user-data-dir=$AppProfile") }
foreach ($p in $chromes) { Stop-Process -Id $p.ProcessId -Force }

Write-Host "Stopping dashboard server..."
$servers = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains("dashboard") -and $_.CommandLine.Contains("--port") -and $_.CommandLine.Contains("7321") }
foreach ($p in $servers) { Stop-Process -Id $p.ProcessId -Force }

Start-Sleep -Milliseconds 500

Write-Host "Re-launching via launcher..."
$Launcher = Join-Path $env:USERPROFILE ".portpilot\launch-dashboard.ps1"
if (Test-Path $Launcher) {
  Start-Process powershell.exe -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden", "-File", $Launcher
  )
  Write-Host "Done. Fresh dashboard window opening."
} else {
  Write-Host "Launcher not found at $Launcher - run 'paat shortcut install' first."
}
