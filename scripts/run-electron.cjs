#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const electronPath = require("electron");
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

const electronArgs = [path.join(__dirname, "..")];

for (const arg of process.argv.slice(2)) {
  if (arg === "--allow-second-instance") {
    env.LUMABURN_ALLOW_SECOND_INSTANCE = "1";
    continue;
  }
  if (arg.startsWith("--port=")) {
    env.PORT = arg.slice("--port=".length);
    continue;
  }
  electronArgs.push(arg);
}

const result = spawnSync(electronPath, electronArgs, {
  stdio: "inherit",
  env,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
