# Port Authority Agent Terminal (paat) installer for Windows
#
# Usage:
#   iwr -useb https://raw.githubusercontent.com/charlesonogwu/port-authority-agent-terminal/main/scripts/install.ps1 | iex
#
# Optional switches (when invoking the script directly, not via `| iex`):
#   .\install.ps1 -NoAutostart    Skip enabling Windows-login autostart.
#                                 (Run `paat autostart install` later if you change your mind.)
#
# What it does:
#   1. Verifies Node.js >= 20 and npm are present (Node 18 hit end-of-life April 2025).
#   2. If the package is published on npm, runs `npm install -g port-authority-agent-terminal-mcp`.
#      Otherwise clones from GitHub, builds, and `npm link`s it.
#   3. Auto-runs `paat config init` so you start with a sensible per-machine cap.
#   4. Installs desktop + Start Menu shortcuts.
#   5. Enables Windows-login autostart (skip with -NoAutostart).
#   6. Prints the next steps you need to actually use it.
#
# Re-running this script is safe — it upgrades in place.

[CmdletBinding()]
param(
  [switch]$NoAutostart
)

$ErrorActionPreference = "Stop"

$REPO_OWNER = "charlesonogwu"                                       # ← replace with your GitHub username before publishing
$REPO_NAME  = "port-authority-agent-terminal"
$REPO_URL   = "https://github.com/$REPO_OWNER/$REPO_NAME.git"
$NPM_NAME   = "port-authority-agent-terminal-mcp"
$BIN_NAME   = "paat"                                          # short CLI alias people actually type

function Write-Step([string]$msg)    { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)      { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn([string]$msg)    { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg)     { Write-Host "  ✗ $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "  Port Authority Agent Terminal (paat)" -ForegroundColor White
Write-Host "  Windows-first lane coordinator for AI coding agents"
Write-Host "  ────────────────────────────────────────────────────"
Write-Host ""

# ── Prerequisites ──────────────────────────────────────────────────────────
Write-Step "Checking prerequisites"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Err "Node.js not found on PATH."
  Write-Host "    Install Node 20 or newer from https://nodejs.org/ and re-run this installer."
  exit 1
}
$nodeVer = (& node --version) -replace '^v',''
$nodeMajor = [int](($nodeVer -split '\.')[0])
if ($nodeMajor -lt 20) {
  Write-Err "Node $nodeVer is too old. portpilot requires Node 20 or newer (Node 18 hit end-of-life April 2025)."
  exit 1
}
Write-Ok "Node $nodeVer"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Err "npm not found on PATH. Reinstall Node.js to get npm."
  exit 1
}
Write-Ok "npm $(& npm --version)"

# ── Install path A: from npm ───────────────────────────────────────────────
$published = $false
try {
  $null = & npm view $NPM_NAME version 2>$null
  if ($LASTEXITCODE -eq 0) { $published = $true }
} catch { }

if ($published) {
  Write-Host ""
  Write-Step "Installing $NPM_NAME from npm"
  & npm install -g $NPM_NAME
  if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
}
else {
  # ── Install path B: from GitHub source ──────────────────────────────────
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "$NPM_NAME is not yet on npm and git is not installed."
    Write-Host "    Either install git from https://git-scm.com/ or wait until $NPM_NAME ships to npm."
    exit 1
  }

  Write-Host ""
  Write-Step "Installing $NPM_NAME from GitHub source"
  $tmp = Join-Path $env:TEMP "paat-install-$([guid]::NewGuid().ToString('N').Substring(0,8))"
  Write-Host "    workdir: $tmp"

  try {
    & git clone --depth 1 $REPO_URL $tmp
    if ($LASTEXITCODE -ne 0) { Write-Err "git clone failed."; exit 1 }

    Push-Location $tmp
    try {
      Write-Host ""
      Write-Step "Installing root dependencies"
      # --ignore-scripts blocks any transitive dependency from running
      # postinstall hooks during bootstrap. Defence-in-depth: this is an
      # iwr|iex installer, the user is trusting our published code, but
      # there's no reason for any of our deps to need a postinstall.
      & npm install --no-audit --no-fund --ignore-scripts
      if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }

      Write-Host ""
      Write-Step "Installing dashboard UI dependencies"
      & npm --prefix "dashboard-ui/portpilot-dashboard" install --no-audit --no-fund --ignore-scripts
      if ($LASTEXITCODE -ne 0) { Write-Err "dashboard-ui npm install failed."; exit 1 }

      Write-Host ""
      Write-Step "Building (server + React dashboard)"
      & npm run build
      if ($LASTEXITCODE -ne 0) { Write-Err "npm run build failed."; exit 1 }

      Write-Host ""
      Write-Step "Linking globally"
      & npm link
      if ($LASTEXITCODE -ne 0) { Write-Err "npm link failed."; exit 1 }
    } finally {
      Pop-Location
    }
    Write-Ok "Installed (linked from $tmp)"
    Write-Warn "Source kept at $tmp so the global symlink stays valid. Delete it later with: Remove-Item -Recurse -Force '$tmp'"
  } catch {
    Write-Err "Install failed: $($_.Exception.Message)"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    exit 1
  }
}

# ── Verify the binary is on PATH ───────────────────────────────────────────
Write-Host ""
Write-Step "Verifying"
$pp = Get-Command $BIN_NAME -ErrorAction SilentlyContinue
if (-not $pp) {
  Write-Err "$BIN_NAME is not on PATH after install."
  Write-Host "    npm prefix: $(npm config get prefix)"
  Write-Host "    Add that path's parent (or 'bin' subfolder) to PATH and reopen your shell."
  exit 1
}
Write-Ok "$BIN_NAME at $($pp.Source)"

# ── First-run config (idempotent) ──────────────────────────────────────────
Write-Host ""
Write-Step "Auto-detecting machine specs and writing default config"
try {
  & $BIN_NAME config init | Out-Null
  Write-Ok "Config written"
} catch {
  Write-Warn "$BIN_NAME config init returned an error — you can run it later by hand."
}

# ── Desktop + Start Menu shortcut ─────────────────────────────────────────
# Installs the clickable icon and the Start Menu entry so Windows Search
# finds the program when the user types "paat" / "port authority".
try {
  & $BIN_NAME shortcut install | Out-Null
  Write-Ok "Desktop shortcut + Start Menu entry installed"
} catch {
  Write-Warn "$BIN_NAME shortcut install failed — run it later by hand."
}

# ── Windows-login autostart ───────────────────────────────────────────────
# Drops a shortcut into the per-user Startup folder so the dashboard boots
# silently when the user logs in. Disable any time with
# `paat autostart uninstall`. Skip entirely with -NoAutostart.
if ($NoAutostart) {
  Write-Warn "Autostart skipped (-NoAutostart). Enable later with: $BIN_NAME autostart install"
} else {
  try {
    & $BIN_NAME autostart install | Out-Null
    Write-Ok "Autostart at Windows login enabled"
  } catch {
    Write-Warn "$BIN_NAME autostart install failed — run it later by hand."
  }
}

# ── Done ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ────────────────────────────────────────────────────" -ForegroundColor Green
Write-Host "  Port Authority Agent Terminal is ready." -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    1. Sign out + sign back in — portpilot will start automatically."
Write-Host "       (Or run 'paat dashboard' right now to skip the wait.)"
Write-Host "    2. Open http://127.0.0.1:7321 after the dashboard starts."
Write-Host ""
Write-Host "  Other:"
Write-Host "    paat help                # see every command"
Write-Host "    paat autostart uninstall # stop auto-starting at login"
Write-Host ""
Write-Host "  CLI aliases shipped: paat, port-authority, portpilot — all do the same thing."
Write-Host ""
Write-Host "  Wire into Claude Desktop / Codex Desktop as an MCP server:"
Write-Host ""
Write-Host '    "paat": { "command": "paat", "args": ["mcp"] }' -ForegroundColor Gray
Write-Host ""
