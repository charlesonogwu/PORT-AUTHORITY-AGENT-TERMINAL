import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, parsePortRange, flagBool, flagInt, flagString } from "../src/cli/args.js";

test("parseArgs handles --key=value", () => {
  const a = parseArgs(["reserve", "--owner=codex", "--cwd=/tmp/x"]);
  assert.equal(a.command, "reserve");
  assert.equal(a.flags.owner, "codex");
  assert.equal(a.flags.cwd, "/tmp/x");
});

test("parseArgs handles --key value", () => {
  const a = parseArgs(["check", "--owner", "codex", "--cwd", "/tmp/x"]);
  assert.equal(a.flags.owner, "codex");
  assert.equal(a.flags.cwd, "/tmp/x");
});

test("parseArgs treats lone --flag as boolean true", () => {
  const a = parseArgs(["status", "--json"]);
  assert.equal(a.flags.json, true);
});

test("parseArgs collects positional after --", () => {
  const a = parseArgs(["reserve", "--owner", "codex", "--", "extra1", "--extra2"]);
  assert.deepEqual(a.positional, ["extra1", "--extra2"]);
});

test("flagBool defaults are honoured", () => {
  const a = parseArgs(["status"]);
  assert.equal(flagBool(a, "json", false), false);
  assert.equal(flagBool(a, "json", true), true);
});

test("flagInt parses valid integers", () => {
  const a = parseArgs(["next", "--port", "9322"]);
  assert.equal(flagInt(a, "port"), 9322);
  assert.equal(flagInt(a, "missing"), undefined);
});

test("flagString returns string for set flags", () => {
  const a = parseArgs(["reserve", "--owner", "codex"]);
  assert.equal(flagString(a, "owner"), "codex");
  assert.equal(flagString(a, "missing", "fallback"), "fallback");
});

test("parsePortRange parses NNN-MMM", () => {
  assert.deepEqual(parsePortRange("9322-9399"), { start: 9322, end: 9399 });
  assert.equal(parsePortRange("badrange"), undefined);
  assert.equal(parsePortRange("9000-1000"), undefined);
  assert.equal(parsePortRange("65535-65536"), undefined);
  assert.equal(parsePortRange("0-10"), undefined);
  assert.equal(parsePortRange(undefined), undefined);
});
