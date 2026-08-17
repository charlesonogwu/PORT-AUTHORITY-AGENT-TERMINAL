import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MANAGED_SKILL_MARKER,
  installAgentSkill,
  portpilotSkillSourceDir,
} from "../src/cli/install-skill.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "portpilot-skill-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("canonical PortPilot skill enforces task-scoped MCP-only browser control", async () => {
  const source = portpilotSkillSourceDir();
  const skill = await readFile(join(source, "SKILL.md"), "utf8");
  const metadata = await readFile(join(source, "agents", "openai.yaml"), "utf8");

  assert.match(skill, /^---\r?\nname: portpilot\r?\n/m);
  assert.match(skill, /only for the current task/i);
  assert.match(skill, /only.*PortPilot MCP/i);
  assert.match(skill, /do not fall back/i);
  assert.match(skill, /stop.*PortPilot MCP.*unavailable/is);
  assert.match(skill, /same owner.*cwd.*sessionId/is);
  assert.match(skill, /page_newtab/);
  assert.match(skill, /omit.*browser.*unless.*user/is);
  assert.match(skill, /personal.*browser profile/i);
  assert.match(metadata, /display_name: "PortPilot"/);
  assert.match(metadata, /allow_implicit_invocation: false/);
});

test("installer writes the canonical skill to Codex and Claude personal skill locations", async () => {
  await withTempDir(async (home) => {
    const codex = await installAgentSkill("codex", { homeDir: home });
    const claude = await installAgentSkill("claude", { homeDir: home });

    assert.equal(codex.action, "installed");
    assert.equal(claude.action, "installed");
    assert.equal(codex.skillDir, join(home, ".codex", "skills", "portpilot"));
    assert.equal(claude.skillDir, join(home, ".claude", "skills", "portpilot"));

    const sourceSkill = await readFile(join(portpilotSkillSourceDir(), "SKILL.md"), "utf8");
    assert.equal(await readFile(join(codex.skillDir, "SKILL.md"), "utf8"), sourceSkill);
    assert.equal(await readFile(join(claude.skillDir, "SKILL.md"), "utf8"), sourceSkill);
    assert.match(await readFile(join(codex.skillDir, "agents", "openai.yaml"), "utf8"), /PortPilot/);
  });
});

test("installer honors explicit Codex and Claude config roots", async () => {
  await withTempDir(async (dir) => {
    const codexHome = join(dir, "codex-home");
    const claudeConfigDir = join(dir, "claude-home");

    const codex = await installAgentSkill("codex", { codexHome });
    const claude = await installAgentSkill("claude", { claudeConfigDir });

    assert.equal(codex.skillDir, join(codexHome, "skills", "portpilot"));
    assert.equal(claude.skillDir, join(claudeConfigDir, "skills", "portpilot"));
  });
});

test("installer is idempotent when the managed skill already matches", async () => {
  await withTempDir(async (home) => {
    await installAgentSkill("codex", { homeDir: home });
    const second = await installAgentSkill("codex", { homeDir: home });

    assert.equal(second.action, "already-installed");
    assert.equal(second.backupPath, null);
  });
});

test("installer refuses to overwrite an unmanaged same-name skill", async () => {
  await withTempDir(async (home) => {
    const skillDir = join(home, ".codex", "skills", "portpilot");
    await mkdir(skillDir, { recursive: true });
    const personal = "---\nname: portpilot\ndescription: My personal skill\n---\nDo my workflow.\n";
    await writeFile(join(skillDir, "SKILL.md"), personal, "utf8");

    const result = await installAgentSkill("codex", { homeDir: home });

    assert.equal(result.action, "conflict");
    assert.match(result.reason ?? "", /not managed by PortPilot/i);
    assert.equal(await readFile(join(skillDir, "SKILL.md"), "utf8"), personal);
  });
});

test("installer updates an older managed skill and preserves a backup", async () => {
  await withTempDir(async (home) => {
    const skillDir = join(home, ".claude", "skills", "portpilot");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `${MANAGED_SKILL_MARKER}\nold managed content\n`, "utf8");

    const result = await installAgentSkill("claude", { homeDir: home });

    assert.equal(result.action, "updated");
    assert.ok(result.backupPath);
    assert.match(await readFile(result.backupPath!, "utf8"), /old managed content/);
    assert.match(await readFile(join(skillDir, "SKILL.md"), "utf8"), /name: portpilot/);
    assert.equal((await installAgentSkill("claude", { homeDir: home })).action, "already-installed");
  });
});

test("managed upgrades remove stale files that are no longer canonical", async () => {
  await withTempDir(async (home) => {
    const first = await installAgentSkill("codex", { homeDir: home });
    const stale = join(first.skillDir, "agents", "obsolete.yaml");
    await writeFile(stale, "stale metadata\n", "utf8");

    const result = await installAgentSkill("codex", { homeDir: home });

    assert.equal(result.action, "updated");
    await assert.rejects(() => readFile(stale, "utf8"), /ENOENT/);
    assert.equal((await installAgentSkill("codex", { homeDir: home })).action, "already-installed");
  });
});

test("installer rejects unsupported clients", async () => {
  await assert.rejects(
    () => installAgentSkill("cursor" as "codex"),
    /unknown skill client.*codex, claude/i,
  );
});

test("install-skill CLI installs Codex and Claude integrations into configured roots", async () => {
  await withTempDir(async (dir) => {
    const codexHome = join(dir, "codex");
    const claudeHome = join(dir, "claude");
    const cli = join(process.cwd(), "dist", "src", "cli", "index.js");
    const result = spawnSync(process.execPath, [cli, "install-skill", "all", "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: claudeHome,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      ok: boolean;
      results: Array<{ client: string; action: string; skillDir: string }>;
    };
    assert.equal(output.ok, true);
    assert.deepEqual(output.results.map((entry) => entry.client), ["codex", "claude"]);
    assert.ok(output.results.every((entry) => entry.action === "installed"));
    assert.match(await readFile(join(codexHome, "skills", "portpilot", "SKILL.md"), "utf8"), /name: portpilot/);
    assert.match(await readFile(join(claudeHome, "skills", "portpilot", "SKILL.md"), "utf8"), /name: portpilot/);
  });
});

test("CLI help and npm lifecycle expose the PortPilot skill installer", async () => {
  const cli = join(process.cwd(), "dist", "src", "cli", "index.js");
  const help = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /install-skill <client>/);
  assert.match(help.stdout, /\/portpilot/);
  assert.match(help.stdout, /Claude Code.*Desktop Code tab/i);

  const postinstall = await readFile(join(process.cwd(), "scripts", "postinstall.cjs"), "utf8");
  assert.match(postinstall, /run\(cliJs, \["install-skill"\]\)/);
  assert.match(postinstall, /Codex and Claude Code/);

  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { files?: string[] };
  assert.ok(pkg.files?.includes("skills/portpilot"), "npm package must include the canonical skill asset");
});
