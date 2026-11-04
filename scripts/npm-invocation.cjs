#!/usr/bin/env node
"use strict";

const { existsSync } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");

/** npm sets npm_execpath to npm-cli.js; pnpm/yarn and .cmd shims set other
 *  files that `node <file>` would either run as the wrong tool or fail on. */
function npmExecPath(env) {
  const value = env.npm_execpath;
  return typeof value === "string" && basename(value).toLowerCase() === "npm-cli.js" ? value : undefined;
}

function npmCliCandidates(execPath, env) {
  return [
    npmExecPath(env),
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "..", "node_modules", "npm", "bin", "npm-cli.js"),
    env.APPDATA && join(env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function npmInvocation(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? process.env;

  if (platform !== "win32") {
    return { command: "npm", args };
  }

  const npmCli = npmCliCandidates(execPath, env)
    .map((candidate) => resolve(candidate))
    .find((candidate) => existsSync(candidate));
  if (!npmCli) {
    throw new Error(
      "Could not locate npm-cli.js. Run this build through `npm run build:dashboard:strict` " +
        "or repair the Node.js/npm installation.",
    );
  }
  return { command: execPath, args: [npmCli, ...args] };
}

module.exports = { npmInvocation };
