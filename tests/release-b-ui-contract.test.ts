import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const app = readFileSync(join(repoRoot, "gui/src/App.tsx"), "utf8");
const client = readFileSync(join(repoRoot, "gui/src/api/client.ts"), "utf8");
const shell = readFileSync(join(repoRoot, "gui/src-tauri/src/lib.rs"), "utf8");
const macApplication = readFileSync(join(repoRoot, "gui/src-tauri/src/macos_application.rs"), "utf8");
const focusCommands = readFileSync(join(repoRoot, "gui/src-tauri/src/commands/focus.rs"), "utf8");
const killCommands = readFileSync(join(repoRoot, "gui/src-tauri/src/commands/kill.rs"), "utf8");
const eraseCommands = readFileSync(join(repoRoot, "gui/src-tauri/src/commands/erase.rs"), "utf8");
const prototypeGuide = readFileSync(join(repoRoot, "docs/MACOS_NATIVE_APP_PROTOTYPE.md"), "utf8");
const prototypeRuntimeConfig = readFileSync(
  join(repoRoot, "scripts/configure-macos-prototype-runtime.cjs"),
  "utf8",
);

test("Release B uses browser-neutral dashboard labels", () => {
  assert.match(app, /LIVE BROWSER SESSIONS/i);
  assert.match(app, /No live browser sessions\./);
  assert.match(app, /Waiting for an agent to launch a browser through PortPilot\./);
  assert.doesNotMatch(app, /No live Chrome sessions\./);
  assert.doesNotMatch(app, /Waiting for an agent to launch Chrome with/);
});

test("macOS Show and Hide use exact-PID application APIs without Accessibility onboarding", () => {
  assert.match(macApplication, /NSRunningApplication/);
  assert.match(macApplication, /runningApplicationWithProcessIdentifier/);
  assert.match(macApplication, /GetProcessForPID/);
  assert.match(macApplication, /ShowHideProcess/);
  assert.match(macApplication, /SetFrontProcessWithOptions/);
  assert.match(macApplication, /SET_FRONT_PROCESS_CAUSED_BY_USER/);
  assert.match(macApplication, /wait_for_state/);
  assert.doesNotMatch(macApplication, /activateWithOptions|yieldActivationToApplication/);
  assert.doesNotMatch(macApplication, /AXUIElement|AXIsProcessTrusted|osascript/);
  assert.doesNotMatch(app, /Accessibility|Enable Show & Hide|Permission required/);
  assert.doesNotMatch(client, /Accessibility|accessibility-revoked/);
  assert.doesNotMatch(shell, /accessibility-onboarding|get_accessibility_status/);
});

test("native window actions remain lane- and process-identity-validated", () => {
  assert.match(app, /if \(!res\.ok\) \{[\s\S]*?hiddenApi\.markHidden/);
  assert.equal(
    [...focusCommands.matchAll(/process_identity::verify\(pid, &process_start\)/g)].length,
    3,
  );
});

test("Show activates the exact displayed Chrome tab before raising its verified PID", () => {
  assert.match(app, /tabId=\{s\.primaryTabs\[0\]\?\.id\}/);
  assert.match(client, /tab: tabId && debugPort \? \{ debugPort, browser, tabId \} : null/);
  assert.match(focusCommands, /checked_cdp_activation/);
  assert.match(focusCommands, /PUT \/json\/activate\/\{target_id\}/);
  assert.match(focusCommands, /requested_port != Some\(lane_port\)/);
  assert.match(focusCommands, /requested_browser != lane_browser/);
  assert.match(focusCommands, /activate_exact_tab\(activation\)\.await/);
  assert.doesNotMatch(focusCommands, /Command::new\([^)]*(curl|osascript)/);
});

test("unused Accessibility settings fallback is not exposed over IPC", () => {
  assert.doesNotMatch(app, /openAccessibilitySettings/);
  assert.doesNotMatch(client, /open_accessibility_settings/);
  assert.doesNotMatch(shell, /open_accessibility_settings/);
});

test("Kill and Erase remain lane-validated but independent of Accessibility", () => {
  assert.match(killCommands, /revalidate_lane_action/);
  assert.match(eraseCommands, /revalidate_lane_action/);
  assert.doesNotMatch(killCommands, /accessibility/i);
  assert.doesNotMatch(eraseCommands, /accessibility/i);
});

test("Release B provides snapshot-only Command+R refresh", () => {
  assert.match(shell, /CommandOrControl\+R/);
  assert.match(shell, /refresh-dashboard/);
  assert.doesNotMatch(shell, /open_devtools|Web Inspector/);
});

test("browser labels remain plain text without colored browser dots", () => {
  assert.match(app, /function BrowserCell/);
  assert.match(app, /className="font-medium" title=\{meta\.title\}/);
  assert.doesNotMatch(app, /browser-dot|rounded-full.*meta\./);
});

test("default browser picker suppresses crowded native arrows", () => {
  assert.match(app, /aria-label="Default browser"/);
  assert.match(app, /appearance-none/);
  assert.match(app, /pointer-events-none absolute right-2\.5/);
});

test("macOS hide uses exact-PID application hiding rather than coordinates", () => {
  assert.match(macApplication, /running_application\(pid\)/);
  assert.doesNotMatch(macApplication, /AXPosition|CGPoint|const OFFSCREEN/);
});

test("macOS full-screen fallback does not require an AX window list", () => {
  assert.doesNotMatch(macApplication, /AXWindows|WindowPlacement/);
  assert.match(prototypeGuide, /NSRunningApplication/i);
  assert.match(prototypeGuide, /physical Mac validation/i);
  assert.match(prototypeGuide, /do not require Accessibility permission/i);
  assert.doesNotMatch(prototypeGuide, /grant.*Accessibility|open System Settings|turn on PortPilot/i);
});

test("macOS prototype documentation states its runtime and window-control boundaries", () => {
  assert.match(prototypeGuide, /verified absolute path/i);
  assert.match(prototypeGuide, /does not search.*PATH/i);
  assert.match(prototypeGuide, /Command\+Q/);
  assert.match(prototypeGuide, /full-screen/i);
  assert.match(prototypeGuide, /minimized/i);
  assert.match(prototypeGuide, /private macOS APIs/i);
  assert.match(prototypeGuide, /unsigned.*arm64 prototype/i);
});

test("an explicit prototype PORTPILOT_HOME must be an existing canonical directory", () => {
  assert.match(
    prototypeRuntimeConfig,
    /canonicalDirectory\(options\["portpilot-home"\], "--portpilot-home"\)/,
  );
});
