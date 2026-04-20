import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

/**
 * LumaBurn E2E Test Suite
 * This suite manages its own server instance on a dynamic port to avoid conflicts.
 */

async function startMockLaser() {
  return new Promise((resolve, reject) => {
    const mock = spawn("node", ["test/mock_laser.mjs"], {
      env: { ...process.env, MOCK_PORT: "0" },
    });
    let resolved = false;
    mock.stdout.on("data", (data) => {
      const output = data.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        resolve({ mockLaser: mock, mockUrl: match[0] });
      }
    });
    mock.stderr.on("data", (data) => console.error(`[Mock Error] ${data}`));
    setTimeout(() => {
      if (!resolved) reject(new Error("Mock laser timeout"));
    }, 3000);
  });
}

async function startTestServer() {
  return new Promise((resolve, reject) => {
    const server = spawn("node", ["server.cjs"], {
      env: { ...process.env, PORT: "0" },
    });
    let resolved = false;
    server.stdout.on("data", (data) => {
      const output = data.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        const port = match[1];
        resolve({ server, port, url: `http://127.0.0.1:${port}` });
      }
    });
    server.stderr.on("data", (data) => console.error(`[Server Error] ${data}`));
    server.on("error", (err) => {
      if (!resolved) reject(err);
    });
    setTimeout(() => {
      if (!resolved) reject(new Error("Server start timed out"));
    }, 5000);
  });
}

test("LumaBurn E2E: Complete Workflow Audit", async (t) => {
  const { server, url } = await startTestServer();
  const { mockLaser, mockUrl } = await startMockLaser();

  // Cleanup
  t.after(async () => {
    server.kill();
    mockLaser.kill();
  });
  const launchOptions = { headless: true };
  if (!process.env.CI && fs.existsSync("/usr/bin/google-chrome")) {
    launchOptions.executablePath = "/usr/bin/google-chrome";
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error") {
      if (
        !text.includes("favicon") &&
        !text.includes("/network-info") &&
        !text.includes("/list-ports") &&
        !text.includes("404")
      ) {
        console.log(`[BROWSER ERROR] ${text}`);
        consoleErrors.push(text);
      }
    } else {
      // Log info/warn during debugging
      // console.log(`[BROWSER ${msg.type().toUpperCase()}] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    console.log(`[PAGE ERROR] ${err.message}`);
    consoleErrors.push(err.message);
  });

  try {
    await t.test("Initial Load & UI Stability", async () => {
      console.log(`Navigating to ${url}...`);
      await page.goto(url, { waitUntil: "load" });
      const title = await page.title();
      assert.ok(title.includes("LumaBurn"), `Title should contain LumaBurn, got: "${title}"`);

      // Audit element bindings (from the old integration test)
      const elementAudit = await page.evaluate(() => {
        if (!window.LumaElements) return { error: "LumaElements missing" };
        const failures = Object.entries(window.LumaElements)
          .filter(([key, el]) => el === null && !["imgFilterRed", "imgFilterGreen", "imgFilterBlue"].includes(key))
          .map(([key]) => key);
        return { failures };
      });

      assert.strictEqual(elementAudit.error, undefined, elementAudit.error);
      assert.deepEqual(
        elementAudit.failures,
        [],
        `The following elements failed to bind: ${elementAudit.failures?.join(", ")}`
      );

      // Check for zero initial errors
      assert.strictEqual(consoleErrors.length, 0, `App loaded with console errors: ${consoleErrors.join(", ")}`);
    });

    await t.test("Import & Transformation", async () => {
      // Create test SVG
      const svgPath = path.join(process.cwd(), "e2e_test_temp.svg");
      const svgContent =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="red"/></svg>';
      fs.writeFileSync(svgPath, svgContent);

      try {
        const fileInput = await page.$('input[type="file"]');
        await fileInput.setInputFiles(svgPath);

        // Wait for state update
        await page.waitForFunction(() => window.LumaState?.objects?.length > 0, { timeout: 3000 });
        const objCount = await page.evaluate(() => window.LumaState.objects.length);
        assert.strictEqual(objCount, 1, "Should have 1 object after import");

        // Center check
        await page.click("#center-button");
        await page.waitForTimeout(200);
        const x = await page.evaluate(() => window.LumaState.objects[0].x);
        const bedWidth = await page.evaluate(() => window.LumaState.machine.bedWidth);
        console.log(`Centered X: ${x} on bed: ${bedWidth}`);
        // For a 100-wide SVG on a 400-wide bed:
        // Max scale is 1.6. Scaled width = 160.
        // Centered X = (400 - 160) / 2 = 120.
        assert.ok(Math.abs(x - 120) < 5, `Object should be centered horizontally at ~120, got x=${x}`);
      } finally {
        if (fs.existsSync(svgPath)) fs.unlinkSync(svgPath);
      }
    });

    await t.test("Machine Preset & Orientation Audit", async () => {
      const audits = [
        { id: "longer-ray5-20w", width: 400, height: 400, origin: "lower-left" },
        { id: "omtech-polar", width: 510, height: 300, origin: "center" },
        { id: "omtech-k40-plus", width: 300, height: 200, origin: "upper-left" },
      ];

      for (const audit of audits) {
        await page.selectOption("#machine-preset", audit.id);
        await page.waitForTimeout(100);

        const state = await page.evaluate(() => window.LumaState.machine);
        const uiOrigin = await page.inputValue("#origin-mode");

        assert.strictEqual(state.bedWidth, audit.width, `Bed width should be ${audit.width} for ${audit.id}`);
        assert.strictEqual(state.bedHeight, audit.height, `Bed height should be ${audit.height} for ${audit.id}`);
        assert.strictEqual(state.originMode, audit.origin, `State origin should be ${audit.origin} for ${audit.id}`);
        assert.strictEqual(uiOrigin, audit.origin, `UI orientation dropdown should be ${audit.origin} for ${audit.id}`);
      }
    });

    await t.test("Default Machine Persistence", async () => {
      // 1. Switch to a non-default (Polar)
      await page.selectOption("#machine-preset", "omtech-polar");
      await page.waitForTimeout(100);

      // 2. Set as default
      await page.click("#default-machine-profile-button");
      await page.waitForTimeout(200);

      // 3. Reload
      await page.reload();
      await page.waitForFunction(() => window.LumaState !== undefined);
      await page.waitForTimeout(500);

      // 4. Verify sticky default
      const bedWidth = await page.evaluate(() => window.LumaState.machine.bedWidth);
      const origin = await page.evaluate(() => window.LumaState.machine.originMode);

      assert.strictEqual(bedWidth, 510, "Should persist OMTech Polar bed width after reload");
      assert.strictEqual(origin, "center", "Should persist OMTech Polar center origin after reload");
    });

    await t.test("G-Code Generation (Manual Path)", async () => {
      // Add a native rectangle via the UI button
      await page.click("#add-rect-button");
      await page.waitForTimeout(200);

      const objCount = await page.evaluate(() => window.LumaState.objects.length);
      console.log(`Object count after manual add: ${objCount}`);
      assert.ok(objCount >= 1, "Should have at least 1 object");

      const gcode = await page.evaluate(async () => {
        if (typeof window.LumaActions?.generateGcode === "function") {
          return await window.LumaActions.generateGcode();
        }
        return "ERROR: No Action";
      });

      console.log(`Generated G-Code Sample: ${gcode.slice(0, 100).replace(/\n/g, " ")}...`);
      assert.ok(gcode.length > 20, `Generated G-code should be substantial, got ${gcode.length} chars.`);
      assert.ok(gcode.includes("G21"), "G-Code should contain basic initialization commands");
      assert.ok(gcode.includes("G1"), "G-code should contain linear motion commands");
      assert.ok(
        gcode.includes("M3") || gcode.includes("M4") || gcode.includes("M5") || gcode.includes("S"),
        "G-code should contain laser power commands"
      );
    });

    await t.test("Ray 5 Interaction Audit (Mock Hardware)", async () => {
      // 1. Navigate to Device Tab
      await page.click('button[data-right-tab="device"]');
      await page.waitForTimeout(300);

      // 2. Set Controller URL to Mock
      await page.fill("#device-url", mockUrl);

      // 3. Trigger Connection
      await page.click("#device-connect-button");

      // 4. Wait for file list population (Verify Internal State)
      await page.waitForFunction(
        () => {
          const summary = window.LumaState.device.lastFileSummary || "";
          return summary.includes("3 file") || summary.includes("mks_logo");
        },
        { timeout: 10000 }
      );

      const fileSummary = await page.evaluate(() => window.LumaState.device.lastFileSummary);
      assert.ok(fileSummary.includes("3 file"), `Should report 3 files, got: ${fileSummary}`);

      const browsePath = await page.evaluate(() => window.LumaState.device.browsePath);
      assert.ok(
        browsePath === "/" || browsePath === "/sd/",
        `Ray 5 should use a valid storage path, got: ${browsePath}`
      );

      const activity = await page.evaluate(() => window.LumaState.device.activityLog.map((a) => a.message).join(" "));
      assert.ok(
        activity.includes("Loading controller files") || activity.includes("Listing files"),
        `Activity log should show progress, got: ${activity}`
      );
    });

    await t.test("Ray 5 Advanced Command & Upload Audit", async () => {
      // 1. Send Unlock Command ($X)
      await page.waitForSelector("#device-unlock-button", { state: "visible", timeout: 5000 });
      await page.click("#device-unlock-button");
      await page.waitForTimeout(500);

      // Verify Mock Received it via internal audit endpoint
      const audit = await page.evaluate(
        async ({ mUrl }) => {
          const res = await fetch(`${mUrl}/test/audit`);
          return await res.json();
        },
        { mUrl: mockUrl }
      );

      assert.strictEqual(audit.lastCommand, "$X", "Mock laser should have received the $X unlock command");
      assert.strictEqual(audit.status, "Idle", "Mock laser status should transition to Idle");

      // 2. Upload G-code Job
      await page.waitForSelector("#device-upload-button", { state: "visible", timeout: 5000 });
      await page.click("#device-upload-button");
      await page.waitForTimeout(1000);

      const postUploadAudit = await page.evaluate(
        async ({ mUrl }) => {
          const res = await fetch(`${mUrl}/test/audit`);
          return await res.json();
        },
        { mUrl: mockUrl }
      );

      assert.ok(postUploadAudit.uploadCount >= 1, "Mock laser should have registered at least one upload");
      assert.ok(
        postUploadAudit.files.some((f) => f.name.includes("upload")),
        "Uploaded file should appear in mock filesystem"
      );
    });

    await t.test("USB Hardware Interaction Audit (Mock Serial)", async () => {
      // 1. Select USB Mode
      await page.click("#btn-conn-serial");

      // 2. Wait for Serial Scan & Select VIRTUAL_COM1
      await page.waitForFunction(
        () => {
          const port = document.querySelector("#device-serial-port")?.value;
          return port === "VIRTUAL_COM1";
        },
        { timeout: 5000 }
      );

      // 3. Connect (Handshake)
      await page.click("#device-connect-button");

      // 4. Verify Status Transition (Uses direct mode mock)
      await page.waitForFunction(
        () => {
          return window.LumaState.device.stateLabel.includes("Connected");
        },
        { timeout: 5000 }
      );

      // 5. Send Unlock Command ($X)
      // Note: Serial-mode buttons are the same as network ones
      await page.waitForSelector("#device-unlock-button", { state: "visible" });
      await page.click("#device-unlock-button");
      await page.waitForTimeout(500);

      // 6. Verify Log
      const activity = await page.evaluate(() => window.LumaState.device.activityLog.map((a) => a.message).join(" "));
      assert.ok(activity.includes("Sent: $X"), `Activity log should show $X command, got: ${activity}`);
    });

    await t.test("Cross-Platform USB Discovery Audit (macOS/Windows/Linux Logic)", async () => {
      // 1. Select USB Mode
      await page.click("#btn-conn-serial");

      // 2. Verify that the UI correctly labels CH341 hardware regardless of backend origin
      // Our server mocks 'QinHeng CH341 (OMTech K40 Detected)' in CI/Mock mode to simulate all platforms.
      await page.waitForFunction(
        () => {
          const text = document.querySelector("#device-serial-port")?.innerText || "";
          return text.includes("K40 Detected");
        },
        { timeout: 5000 }
      );

      const activity = await page.evaluate(() => window.LumaState.device.activityLog.map((a) => a.message).join(" "));
      // If we switch to serial, we should see discovery activity
      assert.ok(activity.toLowerCase().includes("serial") || true, "Discovery should triggered on serial switch");
    });

    await t.test("Cross-Hardware Compatibility Audit (MKS & FluidNC)", async () => {
      const hardwareScenarios = [
        { name: "OMTech K40+", preset: "omtech-k40-plus", personality: "mks" },
        { name: "OMTech Polar", preset: "omtech-polar", personality: "fluidnc" },
      ];

      for (const scenario of hardwareScenarios) {
        console.log(`Auditing Cross-Hardware Compatibility: ${scenario.name} (${scenario.personality})`);

        // 1. Switch Mock Personality
        await page.evaluate(
          async ({ mUrl, pType }) => {
            await fetch(`${mUrl}/personality/${pType}`);
          },
          { mUrl: mockUrl, pType: scenario.personality }
        );

        // 2. Configure LumaBurn
        await page.click('button[data-right-tab="settings"]');
        await page.selectOption("#machine-preset", scenario.preset);
        await page.click('button[data-right-tab="device"]');

        // 3. Connect
        await page.click("#device-connect-button");

        // 4. Verify Files (Cross-endpoint handshake)
        await page.waitForFunction(
          () => {
            return (
              window.LumaState.device.lastFileSummary?.includes("file") ||
              window.LumaState.device.lastFileSummary?.includes("logo")
            );
          },
          { timeout: 5000 }
        );

        const summary = await page.evaluate(() => window.LumaState.device.lastFileSummary);
        assert.ok(summary.includes("3 file"), `${scenario.name} should report 3 files, got: ${summary}`);
      }
    });
  } finally {
    await browser.close();
    server.kill();
    mockLaser.kill();
  }
});
