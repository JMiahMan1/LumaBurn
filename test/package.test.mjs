import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { buildPackages } from "../scripts/build-packages.mjs";

test("buildPackages creates cross-platform package directories and launchers", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lumaburn-packages-"));
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  try {
    const manifest = await buildPackages({ rootDir, distDir: tempDir });
    assert.equal(manifest.packages.length, 3);

    for (const entry of manifest.packages) {
      const effectiveDir = path.join(tempDir, path.basename(entry.directory));
      await fs.access(path.join(effectiveDir, "app", "server.js"));
      await fs.access(path.join(effectiveDir, entry.launcher));
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
