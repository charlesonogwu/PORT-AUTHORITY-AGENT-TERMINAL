import { test } from "node:test";
import assert from "node:assert/strict";
import { isStale, nowIso, ownerSlug, projectSlug, normalizeCwd } from "../src/core/lane.js";

test("projectSlug derives a slug from the last path segment", () => {
  assert.equal(projectSlug("C:\\Users\\dev\\Downloads\\vend-site"), "vend-site");
  assert.equal(projectSlug("/home/dev/projects/My Project!"), "my-project");
  assert.equal(projectSlug("/"), "project");
});

test("ownerSlug strips weird characters and lowercases", () => {
  assert.equal(ownerSlug("Codex"), "codex");
  assert.equal(ownerSlug("Claude_4.7"), "claude-4-7");
  assert.equal(ownerSlug(""), "agent");
});

test("normalizeCwd unifies separators and case-corrects drive letters", () => {
  if (process.platform === "win32") {
    assert.equal(normalizeCwd("c:/Users/dev/proj/"), "C:\\Users\\dev\\proj");
  } else {
    assert.equal(normalizeCwd("/home/dev//proj/"), "/home/dev/proj");
  }
});

test("isStale returns true once lastSeen is older than the stale window", () => {
  const fresh = {
    id: "l",
    owner: "codex",
    project: "p",
    cwd: "/tmp",
    sessionId: "default",
    chromeProfileDir: "/tmp",
    status: "active" as const,
    createdAt: nowIso(),
    lastSeen: nowIso(),
  };
  assert.equal(isStale(fresh), false);
  const old = { ...fresh, lastSeen: new Date(Date.now() - 1000 * 60 * 60).toISOString() };
  assert.equal(isStale(old), true);
});

test("isStale never flags released lanes", () => {
  const released = {
    id: "l",
    owner: "codex",
    project: "p",
    cwd: "/tmp",
    sessionId: "default",
    chromeProfileDir: "/tmp",
    status: "released" as const,
    createdAt: nowIso(),
    lastSeen: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
  };
  assert.equal(isStale(released), false);
});
