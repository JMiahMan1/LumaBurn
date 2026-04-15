import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { chromium } from "playwright";

test("Application Sanity: Initial Load and API presence", async () => {
  const launchOptions = {
    headless: true,
  };

  // On local dev machine, use the system-installed Chrome to avoid missing browser cache.
  // In CI (GitHub Actions), use the default Playwright Chromium binaries.
  if (!process.env.CI && fs.existsSync("/usr/bin/google-chrome")) {
    launchOptions.executablePath = "/usr/bin/google-chrome";
  }

  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();
  const consoleErrors = [];

  page.on("console", (msg) => {
    const text = msg.text();
    const url = msg.location().url || "";
    // Ignore expected 404s for favicon (if automated) or optional network info
    if (url.includes("favicon") || url.includes("/network-info")) {
      return;
    }
    console.log(`BROWSER CONSOLE [${msg.type()}]: ${text}`);
    if (msg.type() === "error" && !text.includes("favicon")) {
      consoleErrors.push(text);
    }
  });

  page.on("pageerror", (err) => {
    consoleErrors.push(err.message);
  });

  try {
    // Navigate to the app (managed by the test lifecycle)
    try {
      await page.goto("http://127.0.0.1:4173", { waitUntil: "load" });
    } catch (err) {
      throw new Error(
        `Failed to connect to LumaBurn server at http://127.0.0.1:4173. Ensure the server is running. Original error: ${err.message}`
      );
    }

    // Check for critical globals
    const globals = await page.evaluate(() => {
      return {
        LumaState: !!window.LumaState,
        LumaActions: !!window.LumaActions,
        LumaElements: !!window.LumaElements,
        elementFailures: Object.entries(window.LumaElements || {})
          .filter(([key, el]) => el === null && !["imgFilterRed", "imgFilterGreen", "imgFilterBlue"].includes(key))
          .map(([key]) => key),
      };
    });

    assert.ok(globals.LumaState, "LumaState should be globally available");
    assert.ok(globals.LumaActions, "LumaActions should be globally available");
    assert.ok(globals.LumaElements, "LumaElements should be globally available");
    assert.deepEqual(
      globals.elementFailures,
      [],
      `The following elements failed to bind: ${globals.elementFailures.join(", ")}`
    );

    // Check for zero errors on load
    assert.equal(consoleErrors.length, 0, `App loaded with console errors: ${consoleErrors.join(", ")}`);
  } finally {
    await browser.close();
  }
});
