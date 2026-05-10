# Reproduces the user's "click many times in a row" scenario and verifies
# the launcher only ever opens ONE dashboard window.

function Count-DashboardWindows {
  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue
  $main = 0
  foreach ($cp in $procs) {
    if (-not $cp.CommandLine) { continue }
    if (-not $cp.CommandLine.Contains("dashboard-app-profile")) { continue }
    $p = Get-Process -Id $cp.ProcessId -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowHandle -ne 0) { $main++ }
  }
  return $main
}

$Launcher = Join-Path $env:USERPROFILE ".portpilot\launch-dashboard.ps1"

Write-Host "Initial dashboard windows: $(Count-DashboardWindows)"

# Fire 5 launchers in parallel, simulating frantic clicking of the shortcut.
Write-Host "Firing 5 parallel launcher invocations..."
$jobs = @()
for ($i = 0; $i -lt 5; $i++) {
  $jobs += Start-Process powershell.exe -ArgumentList @(
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", $Launcher
  ) -PassThru -WindowStyle Hidden
}

# Wait for all the powershell launchers themselves to finish (NOT chrome).
$jobs | ForEach-Object { try { $_.WaitForExit(15000) | Out-Null } catch { } }

Start-Sleep -Seconds 2
$count = Count-DashboardWindows
Write-Host "Dashboard windows after 5 launches: $count"

if ($count -eq 1) {
  Write-Host "PASS - exactly one window."
  exit 0
} else {
  Write-Host "FAIL - expected 1, got $count."
  exit 1
}
