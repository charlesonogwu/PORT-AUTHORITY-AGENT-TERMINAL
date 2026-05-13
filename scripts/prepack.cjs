#!/usr/bin/env node
"use strict";

const { rmSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const rootNodeModules = join(root, "node_modules");

// GitHub installs run `prepare` in a temporary clone before npm builds the
// install tarball. `prepare` may populate root node_modules so TypeScript can
// compile dist/. Remove it before packing so npm cannot sweep the temporary
// dependency tree into the package tarball on Windows.
rmSync(rootNodeModules, { recursive: true, force: true });
console.log("[paat prepack] removed root node_modules from package input");
