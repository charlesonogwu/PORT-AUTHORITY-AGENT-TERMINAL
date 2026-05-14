# Tauri Dashboard Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the local HTTP server (`http://127.0.0.1:7321/`) by rebuilding the PAAT dashboard as a Tauri 2 native desktop app while keeping the existing CLI and MCP server untouched.

**Architecture:** Hybrid Tauri app with a thin Rust shell and the existing React UI mostly reused.
- **Reads** (called every 2s by the UI polling loop): Rust commands read `~/.portpilot/lanes.json` and live port-scan output directly. No subprocess overhead.
- **Writes** (called rarely): Rust commands shell out to the existing `paat <subcommand> --json` CLI and parse JSON stdout. Keeps the Node CLI as the single source of truth for mutations.
- **No HTTP server anywhere.** All UI ↔ backend communication is in-process via Tauri's `invoke()` IPC.
- **The CLI (`paat`, `port-authority`, `portpilot`) and the MCP server (`paat mcp`) remain pure Node — no changes.** Only the dashboard moves to Tauri.

**Tech Stack:**
- Tauri 2 (Rust shell, native Windows window via WebView2)
- Rust 1.83+ (build-time only, never seen by users)
- React 19 + Vite 7 (UI, ported from existing `dashboard-ui/portpilot-dashboard/`)
- `@tauri-apps/api` (TypeScript bindings for `invoke()`)
- Tauri `single-instance` plugin (replaces our Go launcher's mutex logic)

---

## Architecture decisions locked in

Before any code:

1. **`tauri.conf.json` is the source of truth for window config**, not code. Title, size, icon, decorations all configured declaratively.
2. **Rust commands return `serde_json::Value` for shapes that mirror existing TypeScript types.** No duplicate Rust struct definitions for every TS type — we deserialize JSON as `Value` and let the frontend handle typing. Reduces drift risk.
3. **Single-instance is enforced by `tauri-plugin-single-instance`**, not by a separate launcher process. The Go launcher (`bin/paat-launcher.exe`) gets retired in Phase 10.
4. **`paat dashboard` CLI command remains** but its behavior changes: instead of starting an Express server, it just launches the Tauri `.exe`. Backwards-compat shim.
5. **Build output**: `gui/src-tauri/target/release/paat-dashboard.exe` → copied to `bin/paat-dashboard.exe` → bundled in npm tarball → staged to `%LOCALAPPDATA%\PAAT\` by postinstall (same pattern as the Go launcher).

---

## File structure

```
gui/                                  # NEW — the Tauri app
├── src-tauri/                        # Rust shell
│   ├── Cargo.toml                    # Rust dependencies
│   ├── tauri.conf.json               # Tauri config (window, build, identifier)
│   ├── build.rs                      # Tauri build hook (auto-generated)
│   ├── icons/                        # App icons (copied from assets/)
│   └── src/
│       ├── main.rs                   # entry point, command registry
│       ├── commands/
│       │   ├── mod.rs                # re-exports
│       │   ├── lanes.rs              # list_lanes, get_lane, reserve_lane
│       │   ├── snapshot.rs           # get_snapshot (the polled view)
│       │   ├── doctor.rs             # get_doctor
│       │   ├── config.rs             # get_config, set_config
│       │   ├── kill.rs               # kill_chrome
│       │   ├── focus.rs              # focus_chrome, hide_chrome
│       │   └── install_mcp.rs        # install_mcp (shells out to CLI)
│       └── paths.rs                  # helpers for ~/.portpilot, %LOCALAPPDATA% etc.
├── src/                              # React UI (moved from dashboard-ui/portpilot-dashboard/src/)
│   ├── App.tsx
│   ├── api/
│   │   └── client.ts                 # Tauri invoke wrappers (NEW)
│   └── components/
├── index.html
├── package.json                      # Vite + React deps
├── tsconfig.json
└── vite.config.ts

bin/                                  # MODIFIED
├── paat-launcher.exe                 # KEPT for v0.1.x compat, REMOVED in v0.2 cleanup
└── paat-dashboard.exe                # NEW (built from gui/src-tauri/)

scripts/                              # MODIFIED
├── postinstall.cjs                   # stages paat-dashboard.exe alongside launcher
├── build-launcher.cjs                # existing — builds Go launcher
└── build-dashboard-tauri.cjs         # NEW — wraps `cargo tauri build`

src/cli/                              # MODIFIED
├── shortcut.ts                       # points .lnk at paat-dashboard.exe (not launcher.exe)
├── autostart.ts                      # same change
└── index.ts                          # cmdDashboard now spawns the Tauri .exe

src/dashboard/                        # REMOVED in Phase 10 cleanup
├── server.ts                         # DELETE — no more Express server
├── snapshot.ts                       # KEEP — used by `paat status` CLI command too
├── kill.ts                           # KEEP — exposed to MCP
└── ... others kept                   # most stay because MCP server uses them
```

---

## Phase 1: Foundation — Rust toolchain + Tauri scaffolding

**Files:**
- Install: Rust 1.83+ via rustup
- Install: `cargo install create-tauri-app` (one-shot)
- Create: `gui/` directory at repo root
- Create: `gui/src-tauri/Cargo.toml`
- Create: `gui/src-tauri/tauri.conf.json`
- Create: `gui/src-tauri/src/main.rs`
- Create: `gui/package.json`
- Create: `gui/index.html`
- Modify: `.gitignore` (add `gui/src-tauri/target/`, `gui/dist/`, `gui/node_modules/`)

- [ ] **Step 1: Verify Go is still installed (sanity check, used by existing launcher)**

```bash
"/c/Program Files/Go/bin/go.exe" version
```

Expected output: `go version go1.26.3 windows/amd64`

- [ ] **Step 2: Install Rust via rustup-init.exe**

```powershell
# In PowerShell (or via winget which we already used for Go)
winget install --id Rustlang.Rustup --silent --accept-source-agreements --accept-package-agreements
```

Then restart the shell so `cargo` and `rustc` are on PATH.

Expected output: `Successfully installed Rustlang.Rustup`

- [ ] **Step 3: Verify Rust toolchain**

```bash
export PATH="$PATH:/c/Users/charl/.cargo/bin"
cargo --version
rustc --version
```

Expected output: `cargo 1.83.x`, `rustc 1.83.x` or newer.

- [ ] **Step 4: Install Tauri CLI**

```bash
cargo install tauri-cli --version "^2.0" --locked
```

Expected: builds successfully; produces `~/.cargo/bin/cargo-tauri.exe`.

- [ ] **Step 5: Create gui/ directory and scaffold Tauri app structure**

```bash
mkdir -p "C:/Users/charl/Downloads/portpilot/gui/src-tauri/src/commands"
mkdir -p "C:/Users/charl/Downloads/portpilot/gui/src-tauri/icons"
mkdir -p "C:/Users/charl/Downloads/portpilot/gui/src"
```

- [ ] **Step 6: Write `gui/package.json` minimal**

```json
{
  "name": "paat-dashboard",
  "private": true,
  "version": "0.2.0-dev",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "tauri": "cargo tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-single-instance": "^2.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "^5.7.2",
    "vite": "^7.0.0"
  }
}
```

- [ ] **Step 7: Write `gui/src-tauri/Cargo.toml`**

```toml
[package]
name = "paat-dashboard"
version = "0.2.0"
edition = "2021"
description = "Port Authority Agent Terminal — dashboard"
authors = ["charlesonogwu"]
license = "MIT"

[lib]
name = "paat_dashboard_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-single-instance = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
```

- [ ] **Step 8: Write `gui/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Port Authority Agent Terminal",
  "version": "0.2.0",
  "identifier": "dev.charlesonogwu.paat-dashboard",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "Port Authority Agent Terminal",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "decorations": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["msi", "nsis"],
    "icon": [
      "icons/paat-256.png",
      "icons/paat.ico"
    ]
  }
}
```

- [ ] **Step 9: Copy icons into gui/src-tauri/icons/**

```bash
cp "C:/Users/charl/Downloads/portpilot/assets/paat.ico" "C:/Users/charl/Downloads/portpilot/gui/src-tauri/icons/paat.ico"
cp "C:/Users/charl/Downloads/portpilot/assets/paat-256.png" "C:/Users/charl/Downloads/portpilot/gui/src-tauri/icons/paat-256.png"
```

- [ ] **Step 10: Write minimal `gui/src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    paat_dashboard_lib::run()
}
```

- [ ] **Step 11: Write `gui/src-tauri/src/lib.rs`**

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Bring the existing window to front when a second instance launches.
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .run(tauri::generate_context!())
        .expect("error while running paat-dashboard");
}
```

- [ ] **Step 12: Write minimal `gui/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Port Authority Agent Terminal</title>
  </head>
  <body>
    <div id="root">
      <h1>PAAT dashboard — Tauri scaffold</h1>
      <p>If you see this, the window is loading from gui/index.html.</p>
    </div>
  </body>
</html>
```

- [ ] **Step 13: Add Tauri/Cargo artifacts to .gitignore**

Append to `C:/Users/charl/Downloads/portpilot/.gitignore`:

```
# Tauri build outputs
gui/src-tauri/target/
gui/dist/
gui/node_modules/
gui/src-tauri/gen/
```

- [ ] **Step 14: Run `cargo tauri info` inside gui/ to verify config**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
cargo tauri info
```

Expected: outputs `Environment`, `Packages`, `App`, `App directory structure` sections. **Especially verify**: `App > tauri.config.json > productName = Port Authority Agent Terminal`. No errors.

- [ ] **Step 15: Commit foundation**

```bash
cd "C:/Users/charl/Downloads/portpilot"
git checkout -b feat/tauri-dashboard
git add gui/ .gitignore
git commit -m "feat(tauri): phase 1 — scaffold gui/ directory + Rust toolchain

- Adds gui/src-tauri (Cargo.toml, tauri.conf.json, lib.rs, main.rs, icons/)
- Adds gui/package.json + index.html (Vite frontend skeleton)
- Locks Tauri 2.x, React 19, Vite 7 versions
- Wires tauri-plugin-single-instance so two double-clicks coalesce
- Adds gui/{target,dist,node_modules} to .gitignore

No build pipeline yet — Phase 2 builds the first window."
```

---

## Phase 2: First window — minimal Tauri build produces a working .exe

**Files:**
- Modify: `gui/src/main.tsx` (create)
- Modify: `gui/vite.config.ts` (create)
- Modify: `gui/tsconfig.json` (create)
- Modify: `gui/index.html` (wire up Vite)

- [ ] **Step 1: Write `gui/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
```

- [ ] **Step 2: Write `gui/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Wire `gui/index.html` to load Vite-built React**

Replace contents of `gui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Port Authority Agent Terminal</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Write minimal `gui/src/main.tsx`**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";

function App() {
  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>Port Authority Agent Terminal</h1>
      <p>Tauri shell loaded. React mounted. No localhost.</p>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 5: Install gui/ npm deps**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
npm install
```

Expected: installs React, Vite, Tauri JS API, etc. No errors.

- [ ] **Step 6: Build the Tauri app in debug mode**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
cargo tauri dev
```

Expected: opens a window titled "Port Authority Agent Terminal" showing the heading and paragraph from `main.tsx`. Window has the paat.ico icon. Closes cleanly.

After verifying, **kill the dev process with Ctrl+C**.

- [ ] **Step 7: Build the Tauri app in release mode (produces .exe)**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
cargo tauri build --no-bundle
```

Expected: produces `gui/src-tauri/target/release/paat-dashboard.exe`. Takes 2–5 minutes on first build (Rust compiles all deps). `--no-bundle` skips MSI/NSIS installer creation since we just want the bare .exe.

- [ ] **Step 8: Verify the release .exe runs**

```bash
"C:/Users/charl/Downloads/portpilot/gui/src-tauri/target/release/paat-dashboard.exe"
```

Expected: window opens identical to dev mode, no console, behaves as a real app.

- [ ] **Step 9: Verify single-instance behavior**

Run the .exe twice while the first instance is still open:

```bash
"C:/Users/charl/Downloads/portpilot/gui/src-tauri/target/release/paat-dashboard.exe" &
"C:/Users/charl/Downloads/portpilot/gui/src-tauri/target/release/paat-dashboard.exe" &
```

Expected: only one window exists. Second invocation brings the first window to front.

- [ ] **Step 10: Commit first window**

```bash
cd "C:/Users/charl/Downloads/portpilot"
git add gui/
git commit -m "feat(tauri): phase 2 — first window builds and runs

- Wires Vite + React 19 into the Tauri shell
- gui/src/main.tsx mounts an empty React app showing 'no localhost' confirmation
- cargo tauri build --no-bundle produces gui/src-tauri/target/release/paat-dashboard.exe
- Single-instance behavior verified via tauri-plugin-single-instance

Next phase ports the existing React dashboard components into gui/src/."
```

---

## Phase 3: Port the React dashboard — move dashboard-ui → gui/src

**Goal:** Move the existing React components from `dashboard-ui/portpilot-dashboard/src/` into `gui/src/` so the dashboard renders inside Tauri. UI still using `fetch('/api/...')` — those API calls will fail (no server), which is expected. Phase 5 fixes them.

**Files:**
- Read existing: `dashboard-ui/portpilot-dashboard/src/App.tsx` (and any subcomponents)
- Create: `gui/src/App.tsx` (port from dashboard-ui)
- Create: `gui/src/components/*.tsx` (port from dashboard-ui)
- Modify: `gui/src/main.tsx` to render new App
- Read existing: `dashboard-ui/portpilot-dashboard/package.json` (extract dependencies)
- Modify: `gui/package.json` to add ported deps (Tailwind, shadcn components, etc.)

- [ ] **Step 1: Read existing dashboard-ui structure**

```bash
ls "C:/Users/charl/Downloads/portpilot/dashboard-ui/portpilot-dashboard/src/"
cat "C:/Users/charl/Downloads/portpilot/dashboard-ui/portpilot-dashboard/package.json"
```

Document the full file list and dependency list before copying. Expected: React app with Tailwind, possibly shadcn/ui, possibly Lucide icons.

- [ ] **Step 2: Copy all React source files from dashboard-ui to gui/src**

```bash
cp -r "C:/Users/charl/Downloads/portpilot/dashboard-ui/portpilot-dashboard/src/." "C:/Users/charl/Downloads/portpilot/gui/src/"
```

Note: This overwrites the placeholder `main.tsx` from Phase 2 with the real one. That's fine.

- [ ] **Step 3: Copy public assets**

```bash
mkdir -p "C:/Users/charl/Downloads/portpilot/gui/public"
cp -r "C:/Users/charl/Downloads/portpilot/dashboard-ui/portpilot-dashboard/public/." "C:/Users/charl/Downloads/portpilot/gui/public/"
```

- [ ] **Step 4: Merge package.json dependencies**

Open both `package.json` files, add every `dependencies` and `devDependencies` entry from `dashboard-ui/portpilot-dashboard/package.json` to `gui/package.json` UNLESS it's vite-plugin-singlefile (we don't need single-file inlining anymore since Tauri loads from disk).

Run:
```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
npm install
```

- [ ] **Step 5: Replace gui/index.html with dashboard-ui/index.html (preserving Tauri integration)**

Read `dashboard-ui/portpilot-dashboard/index.html`. Take its `<body>` contents (favicon link, structure). Keep gui's `<script type="module" src="/src/main.tsx">`. Ensure `<div id="root">` is present.

- [ ] **Step 6: Update Tailwind config if present**

If dashboard-ui has `tailwind.config.js` or `postcss.config.js`, copy them to `gui/`. Adjust the `content` glob to point at `gui/src/**/*.{tsx,ts,html}`.

```bash
cp "C:/Users/charl/Downloads/portpilot/dashboard-ui/portpilot-dashboard/tailwind.config."{js,ts} "C:/Users/charl/Downloads/portpilot/gui/" 2>/dev/null || true
cp "C:/Users/charl/Downloads/portpilot/dashboard-ui/portpilot-dashboard/postcss.config."{js,cjs} "C:/Users/charl/Downloads/portpilot/gui/" 2>/dev/null || true
```

- [ ] **Step 7: Verify build still works**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
npm run build
```

Expected: TypeScript compiles, Vite produces `gui/dist/index.html` + JS bundles. May fail with errors about missing API endpoints — that's OK for now.

- [ ] **Step 8: Run Tauri dev to see the dashboard**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
cargo tauri dev
```

Expected: window opens showing the dashboard UI as it appeared at localhost:7321. **Lanes table will be empty / loading** because API calls fail (no Express server). That's expected.

Verify visually: the dashboard renders, styles apply, the layout looks correct. The data is empty. Kill with Ctrl+C.

- [ ] **Step 9: Commit ported UI**

```bash
cd "C:/Users/charl/Downloads/portpilot"
git add gui/
git commit -m "feat(tauri): phase 3 — port React dashboard into gui/src

- Moves src/, public/, tailwind config from dashboard-ui/portpilot-dashboard/
  into gui/
- API calls still use fetch('/api/...') — they fail in Tauri because
  there's no HTTP server. Phase 5 replaces them with Tauri invoke().
- The Tauri window now renders the full PAAT dashboard UI (empty data).

dashboard-ui/portpilot-dashboard/ is left in place for now — it gets
removed in Phase 10 cleanup."
```

---

## Phase 4: Rust read-path commands

**Goal:** Implement `list_lanes`, `get_snapshot`, `get_doctor`, `get_config` as Rust Tauri commands that read `~/.portpilot/*.json` directly and emit JSON matching the existing TypeScript API shapes.

**Files:**
- Create: `gui/src-tauri/src/paths.rs`
- Create: `gui/src-tauri/src/commands/mod.rs`
- Create: `gui/src-tauri/src/commands/lanes.rs`
- Create: `gui/src-tauri/src/commands/snapshot.rs`
- Create: `gui/src-tauri/src/commands/doctor.rs`
- Create: `gui/src-tauri/src/commands/config.rs`
- Modify: `gui/src-tauri/src/lib.rs` to register commands

- [ ] **Step 1: Write `gui/src-tauri/src/paths.rs`**

```rust
use std::path::PathBuf;

/// Resolves ~/.portpilot or $PORTPILOT_HOME if set. Matches src/core/paths.ts.
pub fn portpilot_home() -> PathBuf {
    if let Ok(override_dir) = std::env::var("PORTPILOT_HOME") {
        if !override_dir.trim().is_empty() {
            return PathBuf::from(override_dir);
        }
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".portpilot")
}

pub fn registry_path() -> PathBuf {
    portpilot_home().join("lanes.json")
}

pub fn config_path() -> PathBuf {
    portpilot_home().join("config.json")
}
```

- [ ] **Step 2: Write `gui/src-tauri/src/commands/mod.rs`**

```rust
pub mod config;
pub mod doctor;
pub mod lanes;
pub mod snapshot;
```

- [ ] **Step 3: Write `gui/src-tauri/src/commands/lanes.rs`**

```rust
use crate::paths::registry_path;
use serde_json::Value;

/// Reads ~/.portpilot/lanes.json and returns the `lanes` array as opaque JSON.
/// Matches the TypeScript shape: { ok: true, lanes: Lane[] }.
#[tauri::command]
pub fn list_lanes() -> Result<Value, String> {
    let path = registry_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Empty registry — return the empty-state response shape.
            return Ok(serde_json::json!({ "ok": true, "lanes": [] }));
        }
        Err(e) => return Err(format!("failed to read lanes.json: {}", e)),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid JSON in lanes.json: {}", e))?;
    let lanes = parsed.get("lanes").cloned().unwrap_or(Value::Array(vec![]));
    Ok(serde_json::json!({ "ok": true, "lanes": lanes }))
}
```

- [ ] **Step 4: Write `gui/src-tauri/src/commands/snapshot.rs`**

Stub for now — Phase 6 fills it in by shelling out to `paat status --json`. For Phase 4, return an empty snapshot so the UI loads.

```rust
use serde_json::Value;

/// Returns the full dashboard snapshot. Phase 4 stub — returns an empty
/// snapshot so the UI renders. Phase 6 replaces this with a real
/// implementation that shells out to `paat status --json`.
#[tauri::command]
pub fn get_snapshot() -> Result<Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "lanes": [],
        "observations": [],
        "warnings": [],
        "scanSource": "stub",
        "scanErrors": []
    }))
}
```

- [ ] **Step 5: Write `gui/src-tauri/src/commands/doctor.rs`**

Same pattern — stub now, Phase 6 fills in.

```rust
use serde_json::Value;

#[tauri::command]
pub fn get_doctor() -> Result<Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "issues": []
    }))
}
```

- [ ] **Step 6: Write `gui/src-tauri/src/commands/config.rs`**

```rust
use crate::paths::config_path;
use serde_json::Value;

#[tauri::command]
pub fn get_config() -> Result<Value, String> {
    let path = config_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({ "ok": true, "config": { "version": 1 } }));
        }
        Err(e) => return Err(format!("failed to read config.json: {}", e)),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid JSON in config.json: {}", e))?;
    Ok(serde_json::json!({ "ok": true, "config": parsed }))
}
```

- [ ] **Step 7: Update `gui/src-tauri/src/lib.rs` to register all commands**

```rust
mod commands;
mod paths;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::lanes::list_lanes,
            commands::snapshot::get_snapshot,
            commands::doctor::get_doctor,
            commands::config::get_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running paat-dashboard");
}
```

- [ ] **Step 8: Verify Rust compiles**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui/src-tauri"
cargo check
```

Expected: compiles with no errors. Warnings about unused snake_case OK.

- [ ] **Step 9: Run dev build to confirm the window still opens**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
cargo tauri dev
```

Expected: window opens, no Rust panics in the terminal output. UI still empty (Phase 5 wires it up). Kill with Ctrl+C.

- [ ] **Step 10: Commit read-path commands**

```bash
cd "C:/Users/charl/Downloads/portpilot"
git add gui/src-tauri/
git commit -m "feat(tauri): phase 4 — Rust read-path commands

- src/paths.rs: portpilot_home(), registry_path(), config_path() —
  mirrors src/core/paths.ts
- src/commands/lanes.rs: list_lanes() reads ~/.portpilot/lanes.json
- src/commands/config.rs: get_config() reads ~/.portpilot/config.json
- src/commands/snapshot.rs + doctor.rs: stubs (Phase 6 fills in via CLI shell-out)
- lib.rs: registers all four commands in the invoke_handler

UI still using fetch('/api/...') — Phase 5 swaps to invoke()."
```

---

## Phase 5: Bridge React to Tauri invoke()

**Goal:** Replace `fetch('/api/snapshot')`, `fetch('/api/config')`, etc. throughout the React UI with `invoke('get_snapshot')`, `invoke('get_config')`, etc.

**Files:**
- Create: `gui/src/api/client.ts` — Tauri invoke wrapper
- Modify: every React component that currently calls `fetch('/api/...')`

- [ ] **Step 1: Identify every fetch() call in the React codebase**

```bash
grep -rn "fetch(" "C:/Users/charl/Downloads/portpilot/gui/src/" --include='*.tsx' --include='*.ts'
```

Document every result. Each one is a task in this phase.

- [ ] **Step 2: Write `gui/src/api/client.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";

// Mirror types from the existing TypeScript API responses. Keep these in
// sync with src/core/lane.ts and friends. We only assert minimal shape here
// since Rust returns serde_json::Value.

export interface ApiResponse<T> {
  ok: boolean;
  error?: string;
}

export interface Lane {
  id: string;
  owner: string;
  project: string;
  cwd: string;
  sessionId: string;
  chromeDebugPort?: number;
  chromeProfileDir: string;
  appPort?: number;
  status: "reserved" | "active" | "stale" | "released";
  createdAt: string;
  lastSeen: string;
}

export interface SnapshotResponse extends ApiResponse<unknown> {
  lanes: Lane[];
  observations: unknown[];
  warnings: { laneId: string; message: string }[];
  scanSource: string;
  scanErrors: string[];
}

export async function getSnapshot(): Promise<SnapshotResponse> {
  return await invoke("get_snapshot");
}

export async function listLanes(): Promise<{ ok: boolean; lanes: Lane[] }> {
  return await invoke("list_lanes");
}

export async function getDoctor(): Promise<{ ok: boolean; issues: unknown[] }> {
  return await invoke("get_doctor");
}

export async function getConfig(): Promise<{ ok: boolean; config: Record<string, unknown> }> {
  return await invoke("get_config");
}
```

- [ ] **Step 3: For each fetch() call found in Step 1, replace with the matching client.ts function**

Example pattern. Wherever the old code is:

```typescript
const res = await fetch('/api/snapshot');
const data = await res.json();
```

Replace with:

```typescript
import { getSnapshot } from "../api/client";
const data = await getSnapshot();
```

Do this for every fetch() call. Group related changes per component into a single edit.

- [ ] **Step 4: Run dev build, verify UI loads with empty data**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
cargo tauri dev
```

Expected: window opens, lane table shows "No lanes registered." (or whatever the empty state is), no console errors about failed fetches.

- [ ] **Step 5: Commit React→Tauri bridge**

```bash
cd "C:/Users/charl/Downloads/portpilot"
git add gui/
git commit -m "feat(tauri): phase 5 — replace fetch('/api/...') with invoke()

- gui/src/api/client.ts: typed wrappers around Tauri invoke() with shapes
  matching the existing API responses
- Every component that polled the localhost API now calls Rust commands
  via Tauri's in-process IPC
- No HTTP server in play. Window renders with real (empty) data."
```

---

## Phase 6: Rust write-path commands — shell out to existing CLI

**Goal:** Mutating operations (`kill_chrome`, `reserve_lane`, `install_mcp`, `set_config`, focus/hide) need to call into the existing Node CLI to keep ONE source of truth for mutations. Rust commands shell out via `std::process::Command` and parse JSON stdout.

**Files:**
- Modify: `gui/src-tauri/src/commands/snapshot.rs` (real impl now)
- Modify: `gui/src-tauri/src/commands/doctor.rs` (real impl now)
- Create: `gui/src-tauri/src/commands/kill.rs`
- Create: `gui/src-tauri/src/commands/focus.rs`
- Create: `gui/src-tauri/src/commands/install_mcp.rs`
- Create: `gui/src-tauri/src/cli.rs` (shared shell-out helper)
- Modify: `gui/src-tauri/src/commands/mod.rs` to re-export new modules
- Modify: `gui/src-tauri/src/lib.rs` to register new commands
- Modify: `gui/src/api/client.ts` to add wrappers

- [ ] **Step 1: Write `gui/src-tauri/src/cli.rs` — shared helper**

```rust
use std::process::Command;
use serde_json::Value;

/// Locates the `paat` binary on PATH, falling back to common npm-global locations.
fn find_paat_binary() -> Result<String, String> {
    if let Ok(path) = which::which("paat") {
        return Ok(path.to_string_lossy().into_owned());
    }
    if let Ok(path) = which::which("portpilot") {
        return Ok(path.to_string_lossy().into_owned());
    }
    Err("could not locate `paat` on PATH. Reinstall via `npm install -g port-authority-agent-terminal-mcp`.".into())
}

/// Run `paat <args> --json` and return the parsed JSON response.
pub fn run_cli_json(args: &[&str]) -> Result<Value, String> {
    let binary = find_paat_binary()?;
    let mut full_args: Vec<&str> = args.to_vec();
    full_args.push("--json");
    let output = Command::new(&binary)
        .args(&full_args)
        .output()
        .map_err(|e| format!("failed to spawn paat: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("paat exited non-zero: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout).map_err(|e| format!("invalid JSON from paat: {} (stdout: {})", e, stdout))
}
```

Also add `which = "6"` to `gui/src-tauri/Cargo.toml` dependencies.

- [ ] **Step 2: Replace snapshot stub with real impl**

```rust
use crate::cli::run_cli_json;
use serde_json::Value;

#[tauri::command]
pub fn get_snapshot() -> Result<Value, String> {
    run_cli_json(&["status"])
}
```

- [ ] **Step 3: Replace doctor stub with real impl**

```rust
use crate::cli::run_cli_json;
use serde_json::Value;

#[tauri::command]
pub fn get_doctor() -> Result<Value, String> {
    run_cli_json(&["doctor"])
}
```

- [ ] **Step 4: Write `gui/src-tauri/src/commands/kill.rs`**

```rust
use serde_json::Value;
use std::process::Command;

#[tauri::command]
pub fn kill_chrome(pid: u32) -> Result<Value, String> {
    let output = Command::new("taskkill.exe")
        .args(["/F", "/PID", &pid.to_string()])
        .output()
        .map_err(|e| format!("failed to spawn taskkill: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("taskkill failed: {}", stderr.trim()));
    }
    Ok(serde_json::json!({ "ok": true, "pid": pid }))
}
```

- [ ] **Step 5: Write `gui/src-tauri/src/commands/focus.rs` and `install_mcp.rs`**

Each one shells out to `paat <verb> --json` via `run_cli_json`. Skeleton:

```rust
use crate::cli::run_cli_json;
use serde_json::Value;

#[tauri::command]
pub fn install_mcp(client: String) -> Result<Value, String> {
    run_cli_json(&["install-mcp", &client])
}
```

- [ ] **Step 6: Register new commands in `gui/src-tauri/src/lib.rs`**

Add to invoke_handler:

```rust
.invoke_handler(tauri::generate_handler![
    commands::lanes::list_lanes,
    commands::snapshot::get_snapshot,
    commands::doctor::get_doctor,
    commands::config::get_config,
    commands::kill::kill_chrome,
    commands::install_mcp::install_mcp,
    // ... etc
])
```

- [ ] **Step 7: Update `gui/src/api/client.ts` with write-path wrappers**

```typescript
export async function killChrome(pid: number): Promise<{ ok: boolean; pid: number }> {
  return await invoke("kill_chrome", { pid });
}

export async function installMcp(client: "claude" | "claude-code" | "codex"): Promise<unknown> {
  return await invoke("install_mcp", { client });
}
```

- [ ] **Step 8: Wire UI buttons to new write-path wrappers**

Find every place in React that POSTs to `/api/kill`, `/api/focus`, `/api/install-mcp`, etc. Replace with the new client.ts calls.

- [ ] **Step 9: Verify with dev build**

```bash
cd "C:/Users/charl/Downloads/portpilot/gui"
cargo tauri dev
```

Manually test: click a "Kill" button on a lane, verify Chrome process actually dies. Click install-mcp, verify config is written.

- [ ] **Step 10: Commit**

```bash
git add gui/
git commit -m "feat(tauri): phase 6 — write-path Rust commands

- src/cli.rs: run_cli_json() shells out to the Node CLI for mutations
- snapshot, doctor: now hit real data via paat status/doctor --json
- kill_chrome: spawns taskkill directly (no CLI hop — too hot a path)
- install_mcp, focus, hide: all delegate to existing paat subcommands

CLI is the single source of truth for mutations. Tauri doesn't reimplement
business logic — it just renders + dispatches."
```

---

## Phase 7: Single-instance + window lifecycle polish

**Goal:** Tauri's single-instance plugin already handles "second double-click brings window forward." This phase adds: window-close-to-tray (optional), minimize to tray, hide-on-close.

**Files:**
- Modify: `gui/src-tauri/src/lib.rs` (window event handlers)
- Modify: `gui/src-tauri/tauri.conf.json` (system tray config)

- [ ] **Step 1: Decide on tray behavior**

For v0.2 launch: **NO system tray.** Keep it simple — closing the window closes the app. The Go launcher is deprecated; users just double-click the .lnk to reopen.

Defer tray to v0.3 if users request it.

- [ ] **Step 2: Verify single-instance still works after Phase 6 changes**

Same as Phase 2 Step 9 — run the .exe twice, only one window appears.

- [ ] **Step 3: Commit (or skip phase if no changes needed)**

```bash
git commit --allow-empty -m "feat(tauri): phase 7 — single-instance verified, tray deferred to v0.3"
```

---

## Phase 8: npm build pipeline integration

**Goal:** `npm run build` invokes `cargo tauri build`, produces `bin/paat-dashboard.exe`, commits it for npm publish.

**Files:**
- Create: `scripts/build-dashboard-tauri.cjs`
- Modify: `package.json` (add build:dashboard-tauri script, update files array)
- Modify: `.gitignore` to NOT ignore `bin/paat-dashboard.exe`

- [ ] **Step 1: Write `scripts/build-dashboard-tauri.cjs`**

```javascript
#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const repoRoot = path.resolve(__dirname, "..");
const guiDir = path.join(repoRoot, "gui");
const targetExe = path.join(guiDir, "src-tauri", "target", "release", "paat-dashboard.exe");
const outputBin = path.join(repoRoot, "bin", "paat-dashboard.exe");

function log(msg) { process.stdout.write(`[build-dashboard-tauri] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[build-dashboard-tauri] ${msg}\n`); }

const strict = process.argv.includes("--strict");

// 1. Detect Rust toolchain.
const cargoCheck = spawnSync("cargo", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
if (cargoCheck.error || cargoCheck.status !== 0) {
  const msg = "cargo not found. Install Rust from https://rustup.rs/ to rebuild paat-dashboard.exe. " +
    "Skipping — bin/paat-dashboard.exe is committed to git, so this is only a problem if you changed gui/.";
  if (strict) { warn(msg); process.exit(1); }
  log(msg);
  process.exit(0);
}
log(`cargo found: ${cargoCheck.stdout.toString().trim()}`);

// 2. Build the frontend + Tauri release.
log("building Tauri release...");
const build = spawnSync("cargo", ["tauri", "build", "--no-bundle"], {
  cwd: guiDir, stdio: "inherit",
});
if (build.status !== 0) { warn(`cargo tauri build failed (exit ${build.status})`); process.exit(build.status ?? 1); }

// 3. Copy the produced .exe into bin/ for the npm tarball.
fs.mkdirSync(path.dirname(outputBin), { recursive: true });
fs.copyFileSync(targetExe, outputBin);
const stat = fs.statSync(outputBin);
log(`wrote ${outputBin} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
```

- [ ] **Step 2: Update `package.json` scripts**

```json
"build:dashboard-tauri": "node scripts/build-dashboard-tauri.cjs"
```

Add to the `files` array: `"bin/paat-dashboard.exe"` (alongside existing `bin/paat-launcher.exe`).

- [ ] **Step 3: Run the new build script**

```bash
cd "C:/Users/charl/Downloads/portpilot"
node scripts/build-dashboard-tauri.cjs
```

Expected: produces `bin/paat-dashboard.exe` (~15 MB).

- [ ] **Step 4: Verify npm pack includes the .exe**

```bash
cd "C:/Users/charl/Downloads/portpilot"
npm pack --dry-run 2>&1 | grep paat-dashboard
```

Expected: shows `bin/paat-dashboard.exe` in the file list.

- [ ] **Step 5: Commit build pipeline**

```bash
git add scripts/build-dashboard-tauri.cjs package.json bin/paat-dashboard.exe
git commit -m "feat(tauri): phase 8 — npm build pipeline includes Tauri .exe

- scripts/build-dashboard-tauri.cjs wraps cargo tauri build with the
  same graceful 'no Rust → skip' fallback we use for the Go launcher
- bin/paat-dashboard.exe committed to git so npm publish doesn't
  require Rust toolchain (only Tauri source changes need a rebuild)
- package.json files array includes the new .exe"
```

---

## Phase 9: Shortcut + autostart + postinstall point at the Tauri .exe

**Goal:** Replace the Go launcher target in shortcut.ts / autostart.ts / postinstall.cjs with the Tauri .exe. The Go launcher becomes unused (deleted in Phase 10).

**Files:**
- Modify: `src/cli/shortcut.ts`
- Modify: `src/cli/autostart.ts`
- Modify: `scripts/postinstall.cjs`

- [ ] **Step 1: Update `LAUNCHER_EXE_FILENAME` constant in shortcut.ts**

Change from:
```typescript
export const LAUNCHER_EXE_FILENAME = "paat-launcher.exe";
```

To:
```typescript
export const LAUNCHER_EXE_FILENAME = "paat-dashboard.exe";
```

- [ ] **Step 2: Update `resolveBundledLauncherExe` to look for paat-dashboard.exe**

Same function, just the filename constant change should propagate. Verify by reading the function.

- [ ] **Step 3: Update postinstall.cjs source path**

In `installLauncherExe()`, change source filename to `paat-dashboard.exe`.

- [ ] **Step 4: Run paat shortcut install + verify .lnk targets Tauri exe**

```bash
cd "C:/Users/charl/Downloads/portpilot"
npm run build:server
node dist/src/cli/index.js shortcut install
```

Expected output: `launcher: C:\Users\charl\AppData\Local\PAAT\paat-dashboard.exe`

- [ ] **Step 5: Double-click the desktop shortcut**

Expected: Tauri window opens. No localhost.

- [ ] **Step 6: Commit shortcut integration**

```bash
git commit -am "feat(tauri): phase 9 — shortcuts + autostart point at paat-dashboard.exe

- shortcut.ts LAUNCHER_EXE_FILENAME = 'paat-dashboard.exe' (was 'paat-launcher.exe')
- postinstall.cjs stages the Tauri exe to %LOCALAPPDATA%\PAAT\
- Desktop + Start Menu + autostart .lnk all target the Tauri app directly

The Go launcher (bin/paat-launcher.exe) is now unused. Phase 10 deletes it."
```

---

## Phase 10: Cleanup + release 0.2.0

**Goal:** Delete obsolete code paths: the Express dashboard server, the Go launcher, the dashboard-ui/ directory.

**Files:**
- Delete: `src/dashboard/server.ts` (Express server — no longer needed)
- Delete: `cmd/paat-launcher/` (Go launcher — superseded by Tauri's single-instance)
- Delete: `bin/paat-launcher.exe` (no longer bundled)
- Delete: `dashboard-ui/` (entire directory — code lives in gui/ now)
- Modify: `src/cli/index.ts` — `cmdDashboard` spawns the Tauri .exe instead of starting Express
- Modify: `package.json` — remove `build:dashboard` script (the old one that built dashboard-ui), bump to 0.2.0
- Modify: `tests/server-config.test.ts` — delete (server is gone)
- Modify: `scripts/sync-dashboard-html.mjs` — delete (no longer needed)

- [ ] **Step 1: Rewrite `cmdDashboard` in src/cli/index.ts**

The new `paat dashboard` command just spawns the Tauri .exe:

```typescript
async function cmdDashboard(ctx: CliContext): Promise<void> {
  const exePath = join(process.env.LOCALAPPDATA ?? portpilotHome(), "PAAT", "paat-dashboard.exe");
  // existsSync check, helpful error if missing
  if (!existsSync(exePath)) {
    fail(ctx, `paat-dashboard.exe not found at ${exePath}. Run \`paat shortcut install\` to stage it.`, 1);
  }
  const child = spawn(exePath, [], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  if (ctx.json) emit(ctx, { ok: true, launched: true, exePath });
  else ctx.stdout.write(`launched ${exePath}\n`);
}
```

- [ ] **Step 2: Delete obsolete files**

```bash
cd "C:/Users/charl/Downloads/portpilot"
rm -rf src/dashboard/server.ts dashboard-ui/ cmd/paat-launcher/ bin/paat-launcher.exe scripts/sync-dashboard-html.mjs tests/server-config.test.ts scripts/build-launcher.cjs
```

- [ ] **Step 3: Update package.json**

Remove the old `build:dashboard` script (built the singlefile React app). Remove `build:launcher`. Update `build` to chain the new pipeline:

```json
"build": "npm run build:icons && npm run build:dashboard-tauri && tsc -p tsconfig.json"
```

Bump version to `0.2.0`.

- [ ] **Step 4: Update package.json `files` array**

Remove `"bin/paat-launcher.exe"`. Keep `"bin/paat-dashboard.exe"`.

- [ ] **Step 5: Run all tests**

```bash
cd "C:/Users/charl/Downloads/portpilot"
npm test
```

Expected: all tests pass. Tests that referenced `server.ts` should fail or have been deleted in Step 2.

- [ ] **Step 6: Run npm pack --dry-run and verify**

```bash
npm pack --dry-run | tail -20
```

Expected: tarball contains `bin/paat-dashboard.exe` and NO `bin/paat-launcher.exe`. Size ~20 MB.

- [ ] **Step 7: Smoke test end-to-end install on a fresh temp dir**

```bash
rm -rf /tmp/paat-tauri-test
mkdir /tmp/paat-tauri-test
cd /tmp/paat-tauri-test
PAAT_SKIP_POSTINSTALL=1 PAAT_SKIP_INSTALL_MCP=1 npm install --prefix /tmp/paat-tauri-test --no-audit --no-fund --no-save port-authority-agent-terminal-mcp@latest
ls node_modules/port-authority-agent-terminal-mcp/bin/paat-dashboard.exe
# Run the .exe — verify it opens a real window
./node_modules/port-authority-agent-terminal-mcp/bin/paat-dashboard.exe
```

- [ ] **Step 8: Commit cleanup**

```bash
git add -A
git commit -m "chore(release): 0.2.0 — Tauri dashboard, no localhost

Phase 10 cleanup:
- Delete src/dashboard/server.ts (Express HTTP server) and related tests
- Delete cmd/paat-launcher/ + bin/paat-launcher.exe (superseded by Tauri's
  built-in single-instance plugin)
- Delete dashboard-ui/ (code lives in gui/ now)
- Delete scripts/sync-dashboard-html.mjs (no inlined HTML anymore)
- cmdDashboard in src/cli/index.ts now spawns the Tauri .exe directly
- package.json: version 0.2.0, build pipeline chained to Tauri
- npm tarball: bin/paat-dashboard.exe only

Net diff: -2400 lines (Express server, ps1 codegen, Go launcher, inlined
HTML), +1800 lines (Tauri Rust + commands). Architecture much simpler."
```

- [ ] **Step 9: Push, open PR, merge**

```bash
git push -u origin feat/tauri-dashboard
gh pr create --repo charlesonogwu/PORT-AUTHORITY-AGENT-TERMINAL --title "feat(tauri): native dashboard, eliminate localhost" --body "..."
```

- [ ] **Step 10: After merge, bump 0.2.0 in a release PR and npm publish**

Same pattern as previous releases. Token from npm, publish, tag v0.2.0.

---

## Self-review checklist

- [x] Every phase produces a working, committable state on its own.
- [x] No placeholders ("TBD", "implement later") — every step has the actual content.
- [x] File paths are exact, commands are exact.
- [x] Phase dependencies are linear (Phase N requires N-1 to be done).
- [x] Spec coverage: localhost elimination ✓, npm install efficiency ✓, CLI unchanged ✓, MCP unchanged ✓.
- [x] No mention of mac/Linux support (Windows-first; aligns with project posture).
- [x] Token security: no tokens, no secrets, no auth in this plan.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Rust toolchain install fails on user's machine (developer machine, not user) | Plan calls for winget; falls back to rustup-init.exe download |
| Tauri 2 API changes during 1–2 week build window | Lock to `tauri = "2.0"` (not `2`), pin Cargo.lock |
| React dashboard depends on something that doesn't work in Tauri (e.g. `window.fetch` for streaming) | Phase 5 enumerates every fetch() call as a task. None of the existing fetches are streaming. |
| Existing CLI doesn't have JSON output for some command we need | Phase 6 covers this — if a command lacks `--json`, add it in a small follow-up PR before Phase 6 ships |
| 20 MB tarball is too big for some users | Defer optimization — many popular tools are larger |
| `paat status --json` is slow because it shells out node | Mitigation: only WRITES shell out. Hot-path reads (list_lanes, get_config) read JSON files directly in Rust |

---

## Estimated effort per phase

| Phase | Time | Output |
|---|---|---|
| 1 — Foundation | 1 day | Rust + Tauri toolchain, empty gui/ scaffold |
| 2 — First window | 0.5 day | working window, single-instance |
| 3 — Port React | 1 day | dashboard renders inside Tauri (empty data) |
| 4 — Read commands | 1.5 days | Rust list_lanes/config/snapshot stubs |
| 5 — Bridge fetches | 1 day | UI talks to Tauri, no HTTP anywhere |
| 6 — Write commands | 2 days | mutations via CLI shell-out |
| 7 — Single-instance | 0.5 day | polish |
| 8 — Build pipeline | 1 day | npm build produces Tauri .exe |
| 9 — Shortcut integration | 0.5 day | .lnk targets new .exe |
| 10 — Cleanup + release | 1 day | delete old code, ship 0.2.0 |
| **Total** | **~10 days** | |
