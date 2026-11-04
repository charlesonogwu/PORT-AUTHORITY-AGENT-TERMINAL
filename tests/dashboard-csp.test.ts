import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The dashboard webview only loads its own bundled assets and talks to Rust
// over Tauri IPC, so anything else (remote scripts, plugins, framing) should
// be refused by the browser engine itself.
test("Tauri dashboard ships a restrictive content security policy", () => {
  const config = JSON.parse(
    readFileSync(join(repoRoot, "gui", "src-tauri", "tauri.conf.json"), "utf8"),
  ) as { app?: { security?: { csp?: unknown; dangerousDisableAssetCspModification?: unknown } } };
  // Tauri may only skip adding hashes to style-src (so 'unsafe-inline' keeps
  // working for runtime-injected component styles); scripts stay hashed.
  assert.deepEqual(config.app?.security?.dangerousDisableAssetCspModification, ["style-src"]);
  const csp = config.app?.security?.csp;
  assert.equal(typeof csp, "string", "csp must not be null");
  assert.match(String(csp), /default-src\s+'self'/);
  assert.match(String(csp), /script-src\s+'self'(;|$)/, "no inline or remote scripts");
  assert.match(String(csp), /object-src\s+'none'/);
  assert.match(String(csp), /frame-ancestors\s+'none'/);
  assert.match(String(csp), /connect-src[^;]*ipc:/, "Tauri IPC must stay reachable");
  assert.match(String(csp), /connect-src[^;]*http:\/\/ipc\.localhost/, "Windows Tauri IPC must stay reachable");
  assert.doesNotMatch(String(csp), /unsafe-eval|default-src\s+\*/);
});
