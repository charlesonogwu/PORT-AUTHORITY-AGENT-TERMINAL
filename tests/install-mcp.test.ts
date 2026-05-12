/**
 * Tests for src/cli/install-mcp.ts — the engine behind `paat install-mcp`.
 *
 * Every test runs in an isolated temp directory and passes `configPath`
 * explicitly to the install functions, so no test ever touches the user's
 * real Claude Desktop / Codex config file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installClaudeMcp,
  installCodexMcp,
  installMcpFor,
} from "../src/cli/install-mcp.js";

function freshTempDir(): string {
  return mkdtempSync(join(tmpdir(), "paat-install-mcp-"));
}

/* -------------------------------------------------------------------------- */
/*  Claude (JSON)                                                             */
/* -------------------------------------------------------------------------- */

test("install-mcp claude: creates a new config when none exists", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "claude_desktop_config.json");
    const r = await installClaudeMcp({ configPath });

    assert.equal(r.action, "installed");
    assert.equal(r.backupPath, null, "no backup should be made when the file did not exist");
    assert.equal(r.configPath, configPath);

    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.deepEqual(written.mcpServers.paat, { command: "paat", args: ["mcp"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp claude: merges into existing config without clobbering other servers or unrelated keys", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "claude_desktop_config.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            github: { command: "github-mcp-server", args: [] },
          },
          otherSetting: "preserve me",
          deeply: { nested: { value: 42 } },
        },
        null,
        2,
      ),
    );

    const r = await installClaudeMcp({ configPath });
    assert.equal(r.action, "installed");
    assert.ok(r.backupPath, "should have created a backup");
    assert.equal(existsSync(r.backupPath!), true, "backup file should be on disk");

    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
      otherSetting: string;
      deeply: { nested: { value: number } };
    };
    assert.deepEqual(written.mcpServers.paat, { command: "paat", args: ["mcp"] });
    assert.deepEqual(
      written.mcpServers.github,
      { command: "github-mcp-server", args: [] },
      "other mcpServers entries must be preserved",
    );
    assert.equal(written.otherSetting, "preserve me", "top-level unrelated keys must be preserved");
    assert.equal(written.deeply.nested.value, 42, "deeply nested unrelated values must be preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp claude: is idempotent — no change on second run", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "claude_desktop_config.json");

    await installClaudeMcp({ configPath });
    const first = readFileSync(configPath, "utf8");

    const r = await installClaudeMcp({ configPath });
    assert.equal(r.action, "already-installed");

    const second = readFileSync(configPath, "utf8");
    assert.equal(first, second, "file contents should not change on a no-op rerun");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp claude: replaces an existing paat block with different args (action='updated')", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "claude_desktop_config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { paat: { command: "old-paat", args: ["--legacy"] } } }),
    );

    const r = await installClaudeMcp({ configPath });
    assert.equal(r.action, "updated");

    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.deepEqual(written.mcpServers.paat, { command: "paat", args: ["mcp"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp claude: refuses to silently rewrite a malformed JSON config", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "claude_desktop_config.json");
    writeFileSync(configPath, "{ this is not valid json ");

    await assert.rejects(
      () => installClaudeMcp({ configPath }),
      /could not parse existing Claude Desktop config/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp claude: refuses a non-object root (e.g. an array)", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "claude_desktop_config.json");
    writeFileSync(configPath, JSON.stringify([1, 2, 3]));

    await assert.rejects(
      () => installClaudeMcp({ configPath }),
      /could not parse existing Claude Desktop config/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp claude: honors custom command + args options", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "claude_desktop_config.json");
    const r = await installClaudeMcp({
      configPath,
      command: "C:\\custom\\paat.exe",
      args: ["mcp", "--debug"],
    });
    assert.equal(r.action, "installed");
    const written = JSON.parse(readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    assert.deepEqual(written.mcpServers.paat, {
      command: "C:\\custom\\paat.exe",
      args: ["mcp", "--debug"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/*  Codex (TOML)                                                              */
/* -------------------------------------------------------------------------- */

test("install-mcp codex: creates a new config when none exists", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "config.toml");
    const r = await installCodexMcp({ configPath });

    assert.equal(r.action, "installed");
    assert.equal(r.backupPath, null);

    const written = readFileSync(configPath, "utf8");
    assert.match(written, /\[mcp_servers\.paat\]/);
    assert.match(written, /command\s*=\s*"paat"/);
    assert.match(written, /args\s*=\s*\["mcp"\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp codex: appends to existing config preserving other servers", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "config.toml");
    const original =
      "# user config\n" +
      "[mcp_servers.github]\n" +
      'command = "gh-mcp"\n' +
      "args = []\n";
    writeFileSync(configPath, original);

    const r = await installCodexMcp({ configPath });
    assert.equal(r.action, "installed");
    assert.ok(r.backupPath);
    assert.equal(existsSync(r.backupPath!), true);

    const written = readFileSync(configPath, "utf8");
    assert.match(written, /\[mcp_servers\.github\]/, "github entry should be preserved");
    assert.match(written, /command\s*=\s*"gh-mcp"/, "github command should be preserved");
    assert.match(written, /\[mcp_servers\.paat\]/, "paat entry should be appended");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp codex: is idempotent when a paat block already exists", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "config.toml");
    writeFileSync(
      configPath,
      "[mcp_servers.paat]\ncommand = \"paat\"\nargs = [\"mcp\"]\n",
    );
    const before = readFileSync(configPath, "utf8");

    const r = await installCodexMcp({ configPath });
    assert.equal(r.action, "already-installed");

    const after = readFileSync(configPath, "utf8");
    assert.equal(after, before, "file contents must not change when section is already present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp codex: ignores [mcp_servers.paat] strings inside values (only matches a section header)", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "config.toml");
    // A string value that contains the literal text `[mcp_servers.paat]` should
    // NOT be treated as an existing section.
    writeFileSync(
      configPath,
      "[user]\nnote = \"see [mcp_servers.paat] for syntax\"\n",
    );

    const r = await installCodexMcp({ configPath });
    assert.equal(
      r.action,
      "installed",
      "should still install — the [mcp_servers.paat] inside a string is not a real section",
    );
    const written = readFileSync(configPath, "utf8");
    assert.match(written, /\[mcp_servers\.paat\]\s*\ncommand\s*=\s*"paat"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install-mcp codex: honors custom command + args options", async () => {
  const dir = freshTempDir();
  try {
    const configPath = join(dir, "config.toml");
    const r = await installCodexMcp({
      configPath,
      command: "node",
      args: ["C:\\bin\\paat.js", "mcp", "--verbose"],
    });
    assert.equal(r.action, "installed");
    const written = readFileSync(configPath, "utf8");
    assert.match(written, /command\s*=\s*"node"/);
    assert.match(written, /args\s*=\s*\["C:\\\\bin\\\\paat\.js","mcp","--verbose"\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/*  installMcpFor dispatcher                                                  */
/* -------------------------------------------------------------------------- */

test("installMcpFor: rejects unknown client names with a clear error", async () => {
  await assert.rejects(
    () => installMcpFor("cursor" as unknown as "claude", {}),
    /unknown MCP client: cursor/,
  );
});

test("installMcpFor: dispatches to the right backend per client", async () => {
  const dir = freshTempDir();
  try {
    const claudePath = join(dir, "claude_desktop_config.json");
    const codexPath = join(dir, "config.toml");

    const claudeResult = await installMcpFor("claude", { configPath: claudePath });
    const codexResult = await installMcpFor("codex", { configPath: codexPath });

    assert.equal(claudeResult.client, "claude");
    assert.equal(codexResult.client, "codex");
    assert.match(readFileSync(claudePath, "utf8"), /"mcpServers"/);
    assert.match(readFileSync(codexPath, "utf8"), /\[mcp_servers\.paat\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
