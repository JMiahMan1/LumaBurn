#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function defaultTestTargets() {
  const testDir = path.join(__dirname, "..", "test");
  return fs
    .readdirSync(testDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join("test", name));
}

const cliArgs = process.argv.slice(2);
const hasExplicitTargets = cliArgs.some((arg) => !arg.startsWith("-"));
const args = hasExplicitTargets ? cliArgs : [...cliArgs, ...defaultTestTargets()];

const result = spawnSync(process.execPath, ["--test", ...args], {
  stdio: "inherit",
  env: {
    ...process.env,
    LUMABURN_INCLUDE_VIRTUAL_SERIAL: "1",
  },
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
