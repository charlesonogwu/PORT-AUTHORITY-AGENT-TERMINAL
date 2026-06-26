import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isMissingDependencyError,
  missingDependencyName,
  formatMissingDependencyMessage,
} from "../src/cli/mcp-preflight.js";

// ── isMissingDependencyError ────────────────────────────────────────────────

test("isMissingDependencyError: true for ERR_MODULE_NOT_FOUND", () => {
  const err = Object.assign(new Error("Cannot find package '@modelcontextprotocol/sdk' imported from x"), {
    code: "ERR_MODULE_NOT_FOUND",
  });
  assert.equal(isMissingDependencyError(err), true);
});

test("isMissingDependencyError: true for ERR_PACKAGE_PATH_NOT_EXPORTED", () => {
  const err = Object.assign(new Error("No exports main"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  assert.equal(isMissingDependencyError(err), true);
});

test("isMissingDependencyError: true when message says Cannot find module (no code)", () => {
  assert.equal(isMissingDependencyError(new Error("Cannot find module 'zod'")), true);
});

test("isMissingDependencyError: false for an unrelated error", () => {
  const err = Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
  assert.equal(isMissingDependencyError(err), false);
});

test("isMissingDependencyError: false for non-errors", () => {
  assert.equal(isMissingDependencyError(null), false);
  assert.equal(isMissingDependencyError(undefined), false);
  assert.equal(isMissingDependencyError("Cannot find package 'x'"), false);
  assert.equal(isMissingDependencyError({ code: "ERR_MODULE_NOT_FOUND" }), false);
});

// ── missingDependencyName ───────────────────────────────────────────────────

test("missingDependencyName: extracts a scoped package from a 'Cannot find package' message", () => {
  const err = new Error("Cannot find package '@modelcontextprotocol/sdk' imported from C:\\x\\server.js");
  assert.equal(missingDependencyName(err), "@modelcontextprotocol/sdk");
});

test("missingDependencyName: extracts from a 'Cannot find module' message", () => {
  assert.equal(missingDependencyName(new Error("Cannot find module 'zod'")), "zod");
});

test("missingDependencyName: undefined when no package is quoted", () => {
  assert.equal(missingDependencyName(new Error("boom")), undefined);
  assert.equal(missingDependencyName(null), undefined);
});

// ── formatMissingDependencyMessage ──────────────────────────────────────────

test("formatMissingDependencyMessage: includes the package dir and both fix paths", () => {
  const msg = formatMissingDependencyMessage({
    packageDir: "C:\\Users\\me\\Downloads\\portpilot",
    missing: "@modelcontextprotocol/sdk",
  });
  assert.match(msg, /@modelcontextprotocol\/sdk/);
  assert.match(msg, /C:\\Users\\me\\Downloads\\portpilot/);
  // local fix
  assert.match(msg, /npm install/);
  // global reinstall fix
  assert.match(msg, /npm install -g port-authority-agent-terminal-mcp/);
  // a clear single-line headline a human/agent can grep
  assert.match(msg, /dependencies/i);
  assert.ok(msg.endsWith("\n"), "message should end with a newline");
});

test("formatMissingDependencyMessage: still actionable when the package name is unknown", () => {
  const msg = formatMissingDependencyMessage({ packageDir: "/opt/pp" });
  assert.match(msg, /\/opt\/pp/);
  assert.match(msg, /npm install/);
});
