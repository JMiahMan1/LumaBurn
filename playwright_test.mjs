import { chromium } from "playwright";
import fs from "fs";
import os from "os";

(async () => {
  let hasErrors = false;
  console.log(`Environment: ${process.env.CI ? "CI (GitHub Actions)" : "Local Development"}`);
  console.log("Launching browser...");

  const launchOptions = {
    headless: true,
  };

  // Environment Handling: Use local Chrome if available to save time downloading
  // Playwright binaries locally, but strictly use Playwright's isolated Chromium in CI.
  if (!process.env.CI) {
    const chromePaths = {
      linux: "/usr/bin/google-chrome",
      darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      win32: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    };
    const localChrome = chromePaths[os.platform()];
    if (localChrome && fs.existsSync(localChrome)) {
      console.log(`Using system Chrome at: ${localChrome}`);
      launchOptions.executablePath = localChrome;
    }
  }

  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage();

  page.on("console", (msg) => {
    const text = msg.text();
    const url = msg.location().url || "";
    // Ignore expected 404s for favicon or optional network info
    if (url.includes("favicon") || url.includes("/network-info")) return;

    console.log(`BROWSER CONSOLE [${msg.type()}]: ${text}`);
    if (msg.type() === "error" && !text.includes("favicon")) {
      console.error(`FAIL: Detected console error: ${text}`);
      hasErrors = true;
    }
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.endsWith("/network-info") || url.includes("favicon")) return;

    console.error(`REQUEST FAILED: ${url} - ${request.failure()?.errorText}`);
    hasErrors = true;
  });

  page.on("pageerror", (err) => {
    console.error(`BROWSER ERROR: ${err.message}`);
    hasErrors = true;
  });

  try {
    console.log("Navigating to LumaBurn...");
    // 127.0.0.1 is safer than 'localhost' in CI environments to avoid IPv6 resolution issues
    await page.goto("http://127.0.0.1:4173", { waitUntil: "networkidle" });

    // Wait for app state to initialize deterministically
    await page.waitForFunction(() => typeof window.LumaState !== "undefined");

    // --- 1. SVG IMPORT & AUTO-CENTERING TEST ---
    console.log("Creating and uploading a 100x100 'hostile' test SVG (hidden, no stroke/fill)...");
    const svgContent =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><path d="M0 0 L100 0 L100 100 L0 100 Z" style="display: none; visibility: hidden; opacity: 0;" fill="none" stroke="none"/></svg>';
    fs.writeFileSync("test.svg", svgContent);

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await page.evaluate(
      ({ dt, content }) => {
        const file = new File([content], "test.svg", { type: "image/svg+xml" });
        dt.items.add(file);
      },
      { dt: dataTransfer, content: svgContent }
    );

    const fileInput = await page.locator('input[type="file"]#svg-input');
    await fileInput.setInputFiles("test.svg");

    console.log("Waiting for import processing...");
    await page.waitForFunction(() => window.LumaState?.objects?.length === 1, { timeout: 5000 });

    // Verify it was centered. Bed=400x400. 100x100 scaled at max 1.6 = 160x160.
    // Center X/Y should be (400 - 160) / 2 = 120.
    const isCentered = await page.evaluate(() => {
      const obj = window.LumaState.objects[0];
      return Math.abs(obj.x - 120) < 1 && Math.abs(obj.y - 120) < 1;
    });
    if (!isCentered) throw new Error("Imported SVG was not properly centered on the machine bed.");
    console.log("Success: SVG imported, hostile styles bypassed, and automatically centered.");

    // --- 2. MOVE VIA INSPECTOR TEST ---
    console.log("Verifying movement via Inspector...");
    await page.evaluate(() => {
      window.LumaActions.selectObject(window.LumaState.objects[0].id);
      window.LumaActions.render();
    });
    await page.click('button[data-right-tab="edit"]'); // Open inspector
    await page.fill("#layer-x", "10");
    await page.keyboard.press("Enter");
    await page.fill("#layer-y", "20");
    await page.keyboard.press("Enter");

    const isMoved = await page.waitForFunction(() => {
      const obj = window.LumaState.objects[0];
      return Math.abs(obj.x - 10) < 0.1 && Math.abs(obj.y - 20) < 0.1;
    });
    if (!isMoved) throw new Error("Failed to move object via Inspector X/Y inputs.");
    console.log("Success: Object moved via Inspector.");

    // --- 3. UI CENTER BUTTON TEST ---
    console.log("Verifying 'Center Selection' UI Action...");
    await page.click("#center-button");

    const isRecentered = await page.waitForFunction(() => {
      const obj = window.LumaState.objects[0];
      return Math.abs(obj.x - 120) < 1 && Math.abs(obj.y - 120) < 1;
    });
    if (!isRecentered) throw new Error("Center Selection button failed to recenter the object.");
    console.log("Success: Object recentered via Arrange panel button.");

    // --- 4. ADD SHAPE & SCHEMA INTEGRITY TEST ---
    console.log("Verifying Add Shape and Node Schema...");
    await page.click("#add-rect-button");
    await page.waitForFunction(() => window.LumaState?.objects?.length === 2);

    const rectNodeValid = await page.evaluate(() => {
      const rect = window.LumaState.objects[1];
      return (
        rect.scaleX !== undefined &&
        rect.scaleY !== undefined &&
        rect.scale === undefined &&
        rect.operationLayerId !== null
      );
    });
    if (!rectNodeValid) throw new Error("Add Rectangle produced an invalid schema.");
    console.log("Success: Shape added with correct v0.3.0 schema.");

    // --- 5. MULTI-SELECT, GROUPING & MOVING TEST ---
    console.log("Verifying Multi-Select, Grouping, and Moving a Group...");
    await page.evaluate(() => {
      window.LumaState.selectedObjectIds = window.LumaState.objects.map((o) => o.id);
      window.LumaActions.render();
    });

    // Group them
    await page.click("#group-button");
    await page.waitForFunction(
      () => window.LumaState.objects.length === 1 && window.LumaState.objects[0].type === "group"
    );

    // Move the group
    await page.fill("#layer-x", "50");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.LumaState.objects[0].x === 50);
    console.log("Success: Objects grouped and the unified group was moved successfully.");

    // Ungroup them
    await page.click("#ungroup-button");
    await page.waitForFunction(() => window.LumaState.objects.length === 2);
    console.log("Success: Objects ungrouped successfully into independent layers.");

    // --- 6. VISIBILITY OVERRIDE & MODE CYCLING TEST ---
    console.log("Verifying Operation Mode Cycling (Line -> Fill -> Score)...");
    const modes = ["line", "fill", "score"];

    for (const mode of modes) {
      await page.evaluate(() => {
        // Re-select the hostile SVG, which is now one of the exploded children
        const firstId = window.LumaState.objects.find((n) => n.type === "path")?.id;
        if (firstId) window.LumaActions.selectObject(firstId);
        window.LumaActions.render();
      });

      await page.selectOption("#op-mode", mode);

      const styleCheck = await page.waitForFunction((currentMode) => {
        const el = document.querySelector("#editor-canvas [data-object-id] path");
        if (!el) return false;

        const style = window.getComputedStyle(el);
        const isVisible = style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity) > 0;

        if (!isVisible) return false;

        // Verify specific mode styling is correctly applied to the SVG DOM
        if (currentMode === "fill") {
          return parseFloat(style.fillOpacity) > 0; // Fill must be visible
        } else if (currentMode === "score") {
          return style.strokeDasharray !== "none" && style.strokeDasharray !== ""; // Score uses dashed lines
        } else if (currentMode === "line") {
          return style.fill === "none" || style.fillOpacity === "0"; // Line shouldn't have fill
        }
        return true;
      }, mode);

      if (!styleCheck) throw new Error(`Canvas rendering failed in mode: ${mode}. Styles were incorrect or invisible.`);
      console.log(`Success: Mode '${mode}' rendered visibly with correct SVG attributes.`);
    }

    // --- 7. LIVE PROPERTY MUTATION TEST ---
    console.log("Verifying live property updates (Width)...");
    await page.evaluate(() => {
      const rectId = window.LumaState.objects.find((n) => n.type === "rect")?.id;
      if (rectId) window.LumaActions.selectObject(rectId);
      window.LumaActions.render();
    });

    await page.fill("#rect-width", "150");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const rect = window.LumaState.objects.find((n) => n.type === "rect");
      return rect.liveGeometry?.width === 150;
    });
    console.log("Success: Property binding updated internal state.");

    // --- 8. MACHINE BED RESIZE TEST ---
    console.log("Verifying Machine Bed resize updates canvas ViewBox...");
    await page.click('button[data-right-tab="device"]'); // Switch away from edit to free focus
    await page.fill("#bed-width", "600");
    await page.keyboard.press("Enter");

    const viewBoxUpdated = await page.waitForFunction(() => {
      const svg = document.querySelector("#editor-canvas");
      const viewBox = svg.getAttribute("viewBox");
      // Canvas gutter is usually 40 left + 12 right = 52. So 600 + 52 = 652
      return viewBox && viewBox.includes("652");
    });
    if (!viewBoxUpdated) throw new Error("Canvas ViewBox did not update after changing Machine Bed Width.");
    console.log("Success: Canvas ViewBox scaled dynamically to match machine parameters.");

    if (hasErrors) {
      throw new Error("E2E FAIL: Console errors or page errors detected during interactive flow.");
    }

    console.log("E2E PASSED. All UI functionality and SVG visual overrides verified.");
  } catch (err) {
    console.error(`E2E FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
    if (fs.existsSync("test.svg")) {
      fs.unlinkSync("test.svg");
    }
    if (hasErrors) {
      process.exit(1);
    }
  }
})();
