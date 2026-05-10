# One-shot helper: close any duplicate portpilot dashboard windows.
# Identifies dashboard windows by the dedicated --user-data-dir we pass on
# launch — that arg is unique to our launcher, so matching it is unambiguous.

$AppProfile = Join-Path $env:USERPROFILE ".portpilot\dashboard-app-profile"
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains("--user-data-dir=$AppProfile") }

if ($procs) {
  $count = ($procs | Measure-Object).Count
  Write-Host "Closing $count dashboard process(es)..."
  $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "Done. Double-click the desktop shortcut to open one clean dashboard."
} else {
  Write-Host "No portpilot dashboard windows are currently running."
}
