import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_DIST = path.join(DEFAULT_ROOT, "dist");
const APP_FILES = [
  "app.js",
  "index.html",
  "lumaburn-core.mjs",
  "package.json",
  "README.md",
  "server.js",
  "styles.css",
];

function launcherContents(platform) {
  if (platform === "windows") {
    return {
      name: "Start LumaBurn.bat",
      body: [
        "@echo off",
        "setlocal",
        "cd /d %~dp0app",
        "node server.js",
      ].join("\r\n"),
    };
  }

  const name = platform === "macos" ? "Start LumaBurn.command" : "start-lumaburn.sh";
  return {
    name,
    body: [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
      'cd "$SCRIPT_DIR/app"',
      "node server.js",
    ].join("\n"),
  };
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function writeLauncher(targetDir, platform) {
  const launcher = launcherContents(platform);
  const launcherPath = path.join(targetDir, launcher.name);
  await fs.writeFile(launcherPath, launcher.body, "utf8");
  if (platform !== "windows") {
    await fs.chmod(launcherPath, 0o755);
  }
  return launcher.name;
}

export async function buildPackages({ rootDir = DEFAULT_ROOT, distDir = DEFAULT_DIST } = {}) {
  await fs.rm(distDir, { recursive: true, force: true });
  await ensureDir(distDir);

  const manifest = {
    builtAt: new Date().toISOString(),
    packages: [],
  };

  const platforms = [
    { id: "linux", label: "LumaBurn-linux-x64" },
    { id: "macos", label: "LumaBurn-macos" },
    { id: "windows", label: "LumaBurn-windows" },
  ];

  for (const platform of platforms) {
    const packageDir = path.join(distDir, platform.label);
    const appDir = path.join(packageDir, "app");
    await ensureDir(appDir);

    for (const file of APP_FILES) {
      await fs.copyFile(path.join(rootDir, file), path.join(appDir, file));
    }

    const launcher = await writeLauncher(packageDir, platform.id);
    const notesPath = path.join(packageDir, "PACKAGE-README.txt");
    await fs.writeFile(
      notesPath,
      [
        `LumaBurn package for ${platform.id}.`,
        "",
        "Requirements:",
        "- Node.js 20 or newer installed on the target machine.",
        "",
        "Run:",
        `- ${launcher}`,
        "",
        "Then open http://127.0.0.1:4173 in a browser.",
      ].join("\n"),
      "utf8"
    );

    manifest.packages.push({
      platform: platform.id,
      directory: path.relative(rootDir, packageDir),
      launcher,
    });
  }

  await fs.writeFile(path.join(distDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

if (process.argv[1] === __filename) {
  const manifest = await buildPackages();
  console.log(`Built ${manifest.packages.length} LumaBurn packages in ${path.relative(DEFAULT_ROOT, DEFAULT_DIST)}.`);
}
