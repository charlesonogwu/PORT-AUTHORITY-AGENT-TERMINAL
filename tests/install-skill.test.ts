import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MANAGED_SKILL_MARKER,
  SKILL_MANIFEST,
  appDirFor,
  backupRootFor,
  installAgentSkill,
  isInsideFolder,
  isSafeManifestKey,
  portpilotSkillSourceDir,
} from "../src/cli/install-skill.js";

const require = createRequire(import.meta.url);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "portpilot-skill-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A minimal managed skill bundle, optionally with extra files. */
async function writeBundle(dir: string, extra: Record<string, string> = {}): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: portpilot\n---\n${MANAGED_SKILL_MARKER}\nbody\n`, "utf8");
  for (const [file, content] of Object.entries(extra)) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), content, "utf8");
  }
  return dir;
}

test("canonical PortPilot skill enforces task-scoped MCP-only browser control", async () => {
  const source = portpilotSkillSourceDir();
  const skill = await readFile(join(source, "SKILL.md"), "utf8");
  const metadata = await readFile(join(source, "agents", "openai.yaml"), "utf8");

  assert.match(skill, /^---\r?\nname: portpilot\r?\n/m);
  assert.match(skill, /Carry out the supplied browser task.*connected PortPilot MCP tools/i);
  assert.match(skill, /If it is unavailable.*stop instead of substituting/i);
  assert.match(skill, /absolute native project path as `cwd`/i);
  assert.match(skill, /one `sessionId` for this whole task/i);
  assert.match(skill, /lowercase letters, digits and hyphens, at most 40 characters/i);
  assert.match(skill, /find_saved_login/);
  assert.match(skill, /exact immutable `laneId`/i);
  assert.match(skill, /page_newtab/);
  assert.match(skill, /pass `tab` on every page call/i);
  assert.match(skill, /already running.*navigate with `page_goto`/is);
  assert.match(skill, /Omit `browser` unless the user chose one/i);
  assert.match(skill, /Never use a personal browser profile/i);
  assert.match(skill, /`release_lane` only clears bookkeeping; it never closes the browser/i);
  assert.match(skill, /call `close_browser` with its `laneId` first/i);
  assert.match(metadata, /display_name: "PortPilot"/);
  assert.match(metadata, /allow_implicit_invocation: false/);
});

test("installer writes the canonical skill and a manifest to Codex and Claude skill locations", async () => {
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
    const manifest = JSON.parse(await readFile(join(codex.skillDir, SKILL_MANIFEST), "utf8")) as { files: Record<string, string> };
    assert.ok(manifest.files["SKILL.md"] && manifest.files["agents/openai.yaml"], "manifest lists every installed file");
  });
});

test("installer honors explicit Codex and Claude config roots", async () => {
  await withTempDir(async (dir) => {
    const codexHome = join(dir, "codex-home");
    const claudeHome = join(dir, "claude-config");
    const codex = await installAgentSkill("codex", { codexHome });
    const claude = await installAgentSkill("claude", { claudeConfigDir: claudeHome });
    assert.equal(codex.skillDir, join(codexHome, "skills", "portpilot"));
    assert.equal(claude.skillDir, join(claudeHome, "skills", "portpilot"));
  });
});

test("a blank CODEX_HOME or CLAUDE_CONFIG_DIR counts as unset instead of the current folder", () => {
  const env = { CODEX_HOME: "  ", CLAUDE_CONFIG_DIR: "" };
  assert.match(appDirFor("codex", {}, env), /[\\/]\.codex$/);
  assert.match(appDirFor("claude", {}, env), /[\\/]\.claude$/);
});

test("installer is idempotent when the managed skill already matches, with no backup", async () => {
  await withTempDir(async (home) => {
    await installAgentSkill("claude", { homeDir: home });
    const again = await installAgentSkill("claude", { homeDir: home });
    assert.equal(again.action, "already-installed");
    assert.equal(again.backupPath, null);
    assert.deepEqual((await readdir(join(home, ".claude", "skills"))).sort(), ["portpilot"]);
  });
});

test("installer refuses to overwrite an unmanaged same-name skill", async () => {
  await withTempDir(async (home) => {
    const skillDir = join(home, ".claude", "skills", "portpilot");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "my own skill\n", "utf8");
    const result = await installAgentSkill("claude", { homeDir: home });
    assert.equal(result.action, "conflict");
    assert.equal(await readFile(join(skillDir, "SKILL.md"), "utf8"), "my own skill\n");
  });
});

test("a folder whose SKILL.md was renamed away is left alone, not wiped", async () => {
  await withTempDir(async (home) => {
    const first = await installAgentSkill("codex", { homeDir: home });
    await writeFile(join(first.skillDir, "SKILL.md.off"), await readFile(join(first.skillDir, "SKILL.md")));
    await rm(join(first.skillDir, "SKILL.md"));
    await writeFile(join(first.skillDir, "notes.md"), "mine\n", "utf8");

    const result = await installAgentSkill("codex", { homeDir: home });
    assert.equal(result.action, "conflict");
    assert.equal(await readFile(join(first.skillDir, "notes.md"), "utf8"), "mine\n");
    assert.ok(existsSync(join(first.skillDir, "SKILL.md.off")));
    assert.ok(!existsSync(join(first.skillDir, "SKILL.md")), "the skill stays switched off");
  });
});

test("a folder holding only OS clutter counts as empty", async () => {
  await withTempDir(async (home) => {
    const skillDir = join(home, ".claude", "skills", "portpilot");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, ".DS_Store"), "x", "utf8");
    assert.equal((await installAgentSkill("claude", { homeDir: home })).action, "installed");
    assert.equal((await installAgentSkill("claude", { homeDir: home })).action, "already-installed");
  });
});

test("a linked skill folder is never written through", async (t) => {
  await withTempDir(async (home) => {
    const checkout = await writeBundle(join(home, "my-checkout"), { "draft.md": "uncommitted\n" });
    const skills = join(home, ".claude", "skills");
    await mkdir(skills, { recursive: true });
    try {
      await symlink(checkout, join(skills, "portpilot"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.skip("cannot create a directory link here");
      return;
    }
    const result = await installAgentSkill("claude", { homeDir: home });
    assert.equal(result.action, "conflict");
    assert.match(result.reason ?? "", /link/i);
    assert.equal(await readFile(join(checkout, "draft.md"), "utf8"), "uncommitted\n");
    assert.match(await readFile(join(checkout, "SKILL.md"), "utf8"), /body/);
  });
});

test("upgrades keep files a user added and back up only edited PortPilot files", async () => {
  await withTempDir(async (home) => {
    const v1 = await writeBundle(join(home, "bundle-v1"), { "agents/openai.yaml": "v1\n" });
    const first = await installAgentSkill("codex", { homeDir: home, sourceDir: v1 });
    await writeFile(join(first.skillDir, "my-notes.md"), "keep me\n", "utf8");
    await writeFile(join(first.skillDir, "agents", "openai.yaml"), "edited by me\n", "utf8");

    const v2 = await writeBundle(join(home, "bundle-v2"), { "agents/openai.yaml": "v2\n" });
    const result = await installAgentSkill("codex", { homeDir: home, sourceDir: v2 });

    assert.equal(result.action, "updated");
    assert.equal(await readFile(join(first.skillDir, "my-notes.md"), "utf8"), "keep me\n");
    assert.equal(await readFile(join(first.skillDir, "agents", "openai.yaml"), "utf8"), "v2\n");
    assert.ok(result.backupPath, "the user's edit was backed up");
    assert.equal(await readFile(join(result.backupPath!, "agents", "openai.yaml"), "utf8"), "edited by me\n");
    assert.ok(!existsSync(join(result.backupPath!, "SKILL.md")), "an unedited file needs no backup");
  });
});

test("a file PortPilot installed and later dropped is removed; unknown files are not", async () => {
  await withTempDir(async (home) => {
    const v1 = await writeBundle(join(home, "bundle-v1"), { "agents/obsolete.yaml": "old\n" });
    const first = await installAgentSkill("codex", { homeDir: home, sourceDir: v1 });
    await writeFile(join(first.skillDir, "agents", "mine.yaml"), "mine\n", "utf8");

    const v2 = await writeBundle(join(home, "bundle-v2"));
    const result = await installAgentSkill("codex", { homeDir: home, sourceDir: v2 });

    assert.equal(result.action, "updated");
    assert.ok(!existsSync(join(first.skillDir, "agents", "obsolete.yaml")));
    assert.equal(await readFile(join(first.skillDir, "agents", "mine.yaml"), "utf8"), "mine\n");
    assert.equal(result.backupPath, null, "the dropped file was unedited, so nothing needed a backup");
  });
});

test("a corrupt or planted manifest can't make an upgrade delete anything outside the skill", async () => {
  await withTempDir(async (home) => {
    const first = await installAgentSkill("codex", { homeDir: home });
    const outside = join(home, "precious.txt");
    await writeFile(outside, "do not delete\n", "utf8");
    await mkdir(join(first.skillDir, "a-folder"));
    const manifest = JSON.parse(await readFile(join(first.skillDir, SKILL_MANIFEST), "utf8")) as { files: Record<string, string> };
    manifest.files["../../../precious.txt"] = "0".repeat(64);
    manifest.files[outside] = "0".repeat(64);
    manifest.files["a-folder"] = "0".repeat(64);
    await writeFile(join(first.skillDir, SKILL_MANIFEST), JSON.stringify(manifest), "utf8");

    await installAgentSkill("codex", { homeDir: home });

    assert.equal(await readFile(outside, "utf8"), "do not delete\n");
    assert.ok(existsSync(join(first.skillDir, "a-folder")), "a folder is never removed");
  });
});

test("manifest keys must stay inside the skill folder", () => {
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:\\Windows\\x", "\\\\srv\\share\\x", "agents\\openai.yaml", "", "a//b", "./x"]) {
    assert.equal(isSafeManifestKey(bad), false, bad);
  }
  for (const good of ["SKILL.md", "agents/openai.yaml", "a/b/c.txt"]) assert.equal(isSafeManifestKey(good), true, good);
});

test("an older managed copy without a manifest is upgraded without deleting anything", async () => {
  await withTempDir(async (home) => {
    const skillDir = join(home, ".claude", "skills", "portpilot");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `${MANAGED_SKILL_MARKER}\nold managed content\n`, "utf8");
    await writeFile(join(skillDir, "extra.md"), "unknown history\n", "utf8");

    const result = await installAgentSkill("claude", { homeDir: home });

    assert.equal(result.action, "updated");
    assert.ok(result.backupPath);
    assert.match(await readFile(join(result.backupPath!, "SKILL.md"), "utf8"), /old managed content/);
    assert.equal(await readFile(join(skillDir, "extra.md"), "utf8"), "unknown history\n");
    assert.match(await readFile(join(skillDir, "SKILL.md"), "utf8"), /name: portpilot/);
    assert.equal((await installAgentSkill("claude", { homeDir: home })).action, "already-installed");
  });
});

test("backups are kept outside every skills folder and pruned to the newest three", async () => {
  await withTempDir(async (home) => {
    const skills = join(home, ".codex", "skills");
    await installAgentSkill("codex", { homeDir: home });
    for (let i = 0; i < 4; i++) {
      await writeFile(join(skills, "portpilot", "SKILL.md"), `${MANAGED_SKILL_MARKER}\nedit ${i}\n`, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await installAgentSkill("codex", { homeDir: home });
      assert.ok(result.backupPath?.startsWith(backupRootFor("codex", { homeDir: home })));
    }
    // Codex and Claude Code load every skills/<name>/SKILL.md; a backup there would load as a stale duplicate.
    assert.deepEqual(await readdir(skills), ["portpilot"]);
    assert.equal((await readdir(backupRootFor("codex", { homeDir: home }))).length, 3);
  });
});

test("a leftover temp file from an interrupted install doesn't block the next one", async () => {
  await withTempDir(async (home) => {
    const skillDir = join(home, ".claude", "skills", "portpilot");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md.portpilot-tmp-4242-deadbeef"), "partial", "utf8");
    assert.equal((await installAgentSkill("claude", { homeDir: home })).action, "installed");
    assert.equal((await installAgentSkill("claude", { homeDir: home })).action, "already-installed");
  });
});

test("look-alike manifest keys never delete a file PortPilot still ships", async () => {
  await withTempDir(async (home) => {
    const first = await installAgentSkill("codex", { homeDir: home });
    const manifest = JSON.parse(await readFile(join(first.skillDir, SKILL_MANIFEST), "utf8")) as { files: Record<string, string> };
    manifest.files["skill.md"] = "0".repeat(64);
    manifest.files["agents\\openai.yaml"] = "0".repeat(64);
    await writeFile(join(first.skillDir, SKILL_MANIFEST), JSON.stringify(manifest), "utf8");
    await writeFile(join(first.skillDir, "SKILL.md"), `${MANAGED_SKILL_MARKER}\nolder text\n`, "utf8");

    await installAgentSkill("codex", { homeDir: home });

    assert.match(await readFile(join(first.skillDir, "SKILL.md"), "utf8"), /name: portpilot/);
    assert.ok(existsSync(join(first.skillDir, "agents", "openai.yaml")));
  });
});

test("a link inside the skill folder can't redirect a write or a delete outside it", async (t) => {
  await withTempDir(async (home) => {
    const first = await installAgentSkill("codex", { homeDir: home });
    const outside = join(home, "elsewhere");
    await mkdir(outside);
    await writeFile(join(outside, "x.txt"), "keep\n", "utf8");
    await rm(join(first.skillDir, "agents"), { recursive: true });
    try {
      await symlink(outside, join(first.skillDir, "agents"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.skip("cannot create a directory link here");
      return;
    }
    const manifest = JSON.parse(await readFile(join(first.skillDir, SKILL_MANIFEST), "utf8")) as { files: Record<string, string> };
    manifest.files["agents/x.txt"] = "0".repeat(64);
    await writeFile(join(first.skillDir, SKILL_MANIFEST), JSON.stringify(manifest), "utf8");

    await assert.rejects(installAgentSkill("codex", { homeDir: home }), /outside the skill folder/);
    assert.equal(await readFile(join(outside, "x.txt"), "utf8"), "keep\n");
    assert.ok(!existsSync(join(outside, "openai.yaml")), "nothing was written through the link");
  });
});

test("isInsideFolder only accepts the folder itself and paths below it", () => {
  const root = join(tmpdir(), "skill-root");
  assert.equal(isInsideFolder(root, root), true);
  assert.equal(isInsideFolder(root, join(root, "agents", "a.yaml")), true);
  assert.equal(isInsideFolder(root, join(root, "..", "other")), false);
  assert.equal(isInsideFolder(root, join(tmpdir(), "skill-root-2")), false);
});

test("onlyExistingApps skips an app that isn't installed and creates nothing", async () => {
  await withTempDir(async (home) => {
    const result = await installAgentSkill("codex", { homeDir: home, onlyExistingApps: true });
    assert.equal(result.action, "skipped");
    assert.ok(!existsSync(join(home, ".codex")));
    await mkdir(join(home, ".codex"));
    assert.equal((await installAgentSkill("codex", { homeDir: home, onlyExistingApps: true })).action, "installed");
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
      env: { ...process.env, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome },
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

test("install-skill --only-existing leaves missing app folders alone", async () => {
  await withTempDir(async (dir) => {
    const cli = join(process.cwd(), "dist", "src", "cli", "index.js");
    const result = spawnSync(process.execPath, [cli, "install-skill", "all", "--only-existing", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: join(dir, "codex"), CLAUDE_CONFIG_DIR: join(dir, "claude") },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as { results: Array<{ action: string }> };
    assert.ok(output.results.every((entry) => entry.action === "skipped"));
    assert.ok(!existsSync(join(dir, "codex")) && !existsSync(join(dir, "claude")));
  });
});

test("install-skill --only-existing reports a folder it leaves alone without failing", async () => {
  await withTempDir(async (dir) => {
    const claudeHome = join(dir, "claude");
    await mkdir(join(claudeHome, "skills", "portpilot"), { recursive: true });
    await writeFile(join(claudeHome, "skills", "portpilot", "SKILL.md"), "my own skill\n", "utf8");
    const cli = join(process.cwd(), "dist", "src", "cli", "index.js");
    const result = spawnSync(process.execPath, [cli, "install-skill", "claude", "--only-existing"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /left unchanged/);
    assert.equal(await readFile(join(claudeHome, "skills", "portpilot", "SKILL.md"), "utf8"), "my own skill\n");
  });
});

test("postinstall skips the skill when asked, under sudo, and for dependency installs", async () => {
  const previous = { ...process.env };
  process.env.PAAT_POSTINSTALL_NO_RUN = "1";
  try {
    const postinstall = require(join(process.cwd(), "scripts", "postinstall.cjs")) as {
      shouldSkip(): string | null;
      skillSkipReason(env: NodeJS.ProcessEnv): string | null;
    };
    assert.match(postinstall.skillSkipReason({ PAAT_SKIP_INSTALL_SKILL: "1" }) ?? "", /PAAT_SKIP_INSTALL_SKILL/);
    assert.match(postinstall.skillSkipReason({ PAAT_SKIP_INSTALL_MCP: "1" }) ?? "", /PAAT_SKIP_INSTALL_MCP/);
    assert.match(postinstall.skillSkipReason({ SUDO_UID: "501" }) ?? "", /sudo/);
    assert.equal(postinstall.skillSkipReason({}), null);

    await withTempDir(async (project) => {
      await writeFile(join(project, "package.json"), JSON.stringify({ name: "some-app" }), "utf8");
      for (const key of ["PAAT_SKIP_POSTINSTALL", "CI", "PAAT_PREPARE_RUNNING", "npm_config_global", "npm_config_location"]) delete process.env[key];
      process.env.INIT_CWD = project;
      assert.equal(postinstall.shouldSkip(), "transitive install");
      process.env.npm_config_global = "true";
      assert.equal(postinstall.shouldSkip(), null, "a global install runs");
      delete process.env.npm_config_global;
      process.env.npm_config_location = "global";
      assert.equal(postinstall.shouldSkip(), null, "npm i --location=global runs too");
      delete process.env.npm_config_location;
      process.env.INIT_CWD = process.cwd();
      assert.equal(postinstall.shouldSkip(), null, "installing inside the PortPilot checkout runs");
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

test("CLI help and npm lifecycle expose the PortPilot skill installer", async () => {
  const cli = join(process.cwd(), "dist", "src", "cli", "index.js");
  const help = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /install-skill <client>/);
  assert.match(help.stdout, /\/skill:Portpilot/);
  assert.match(help.stdout, /\$portpilot/);
  assert.match(help.stdout, /\/portpilot/);

  const postinstall = await readFile(join(process.cwd(), "scripts", "postinstall.cjs"), "utf8");
  assert.match(postinstall, /run\(cliJs, \["install-skill", "all", "--only-existing"\]\)/);

  const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { files?: string[] };
  assert.ok(pkg.files?.includes("skills/portpilot"), "npm package must include the canonical skill asset");
});
