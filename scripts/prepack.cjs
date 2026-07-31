#!/usr/bin/env node
"use strict";

// npm excludes node_modules from package tarballs, and package.json has an
// explicit files allowlist. Deleting the developer's dependency tree here made
// `npm pack` and `npm publish` unexpectedly destructive and broke later builds.
console.log("[paat prepack] package contents are controlled by package.json; dependencies left intact");
