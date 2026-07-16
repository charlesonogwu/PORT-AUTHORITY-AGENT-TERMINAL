#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`[PortPilot prototype runtime] ${message}\n`);
  process.exitCode = 1;
}

function argsOf(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    result[arg.slice(2)] = value;
    i += 1;
  }
  return result;
}

function canonicalFile(value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const canonical = fs.realpathSync(value);
  if (!fs.statSync(canonical).isFile()) throw new Error(`${label} is not a regular file`);
  return canonical;
}

function canonicalDirectory(value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const canonical = fs.realpathSync(value);
  if (!fs.statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory`);
  return canonical;
}

function buildConfig(options) {
  const nodeExecutable = canonicalFile(options.node, "--node");
  const packageRoot = canonicalDirectory(options["package-root"], "--package-root");
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "port-authority-agent-terminal-mcp") {
    throw new Error("--package-root is not the PortPilot npm package");
  }
  if (packageJson.version !== "0.4.0") {
    throw new Error(`the Release B prototype requires PortPilot 0.4.0, found ${String(packageJson.version)}`);
  }
  const cliEntry = canonicalFile(
    path.join(packageRoot, "dist", "src", "cli", "index.js"),
    "PortPilot CLI entry",
  );
  const relativeCli = path.relative(packageRoot, cliEntry);
  if (relativeCli.startsWith("..") || path.isAbsolute(relativeCli)) {
    throw new Error("PortPilot CLI entry escapes the verified package root");
  }

  const config = {
    provider: "installed",
    nodeExecutable,
    packageRoot,
    cliEntry,
    expectedPortpilotVersion: packageJson.version,
  };
  if (options["portpilot-home"]) {
    config.portpilotHome = canonicalDirectory(options["portpilot-home"], "--portpilot-home");
  }
  return config;
}

function defaultOutputPath() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.charlesonogwu.portpilot",
    "runtime-provider.json",
  );
}

function writeConfig(config, outputPath) {
  if (!path.isAbsolute(outputPath)) throw new Error("--out must be an absolute path");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  let backup = null;
  if (fs.existsSync(outputPath)) {
    backup = `${outputPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(outputPath, backup);
  }
  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, outputPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return backup;
}

function main() {
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new Error("this prototype configuration helper requires an arm64 Mac");
    }
    const options = argsOf(process.argv.slice(2));
    if (!options.node || !options["package-root"]) {
      throw new Error(
        "usage: npm run configure:mac-prototype-runtime -- --node /absolute/node --package-root /absolute/npm/package [--portpilot-home /temporary/home] [--out /absolute/config.json]",
      );
    }
    const config = buildConfig(options);
    const output = options.out ? path.resolve(options.out) : defaultOutputPath();
    const backup = writeConfig(config, output);
    process.stdout.write(`Configured the verified PortPilot runtime at ${output}\n`);
    if (backup) process.stdout.write(`Previous configuration backed up at ${backup}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (require.main === module) main();

module.exports = { argsOf, buildConfig, defaultOutputPath, writeConfig };
