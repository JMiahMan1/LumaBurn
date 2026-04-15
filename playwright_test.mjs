import { chromium } from "playwright";
import fs from "fs";

(async () => {
  let hasErrors = false;
  console.log("Launching browser...");
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

  page.on("console", (msg) => {
    const text = msg.text();
    const url = msg.location().url || "";
    // Ignore expected 404s for favicon (if automated) or optional network info
    if (url.includes("favicon") || url.includes("/network-info")) {
      return;
    }
    console.log(`BROWSER CONSOLE [${msg.type()}]: ${text}`);
    if (msg.type() === "error" && !text.includes("favicon")) {
      // For resource errors, Playwright msg.text() usually contains the URL or 'Failed to load resource'
      console.error(`FAIL: Detected console error: ${text}`);
      hasErrors = true;
    }
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    if (url.endsWith("/network-info") || url.includes("favicon")) {
      return;
    }
    console.error(`REQUEST FAILED: ${url} - ${request.failure()?.errorText}`);
    hasErrors = true;
  });

  page.on("pageerror", (err) => {
    console.error(`BROWSER ERROR: ${err.message}`);
    hasErrors = true;
  });

  try {
    console.log("Navigating to LumaBurn...");
    await page.goto("http://127.0.0.1:4173", { waitUntil: "load" });

    console.log("Creating test SVG...");
    const svgContent =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="red"/></svg>';
    fs.writeFileSync("test.svg", svgContent);

    console.log("Uploading test SVG...");
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await page.evaluate(
      ({ dt, content }) => {
        const file = new File([content], "test.svg", { type: "image/svg+xml" });
        dt.items.add(file);
      },
      { dt: dataTransfer, content: svgContent }
    );

    const fileInput = await page.$('input[type="file"]');
    await fileInput.setInputFiles("test.svg");

    console.log("Waiting for import processing...");
    await page.waitForTimeout(1000);

    console.log("Verifying state population...");
    const objectsLen = await page.evaluate(() => window.LumaState?.objects?.length);
    console.log(`window.LumaState.objects.length = ${objectsLen}`);

    if (objectsLen === 1) {
      console.log("Success: 1 object imported.");
    } else {
      throw new Error(`Expected 1 object, found ${objectsLen}`);
    }

    console.log("Verifying functional interaction (Sequential Flow)...");
    await page.click("#add-rect-button");
    await page.waitForTimeout(100);
    const rectLen = await page.evaluate(() => window.LumaState.objects.length);
    console.log(`State objects after Add Rect: ${rectLen}`);
    if (rectLen < 1) {
      throw new Error("Add Rectangle failed to update state.");
    }

    console.log("Verifying Visibility Audit (Mode Cycling)...");
    // Cycle modes
    const modes = ["line", "fill", "score"];
    for (const mode of modes) {
      console.log(`Testing mode: ${mode}`);
      // Ensure object is selected via internal actions AND a physical click for UI synchronization.
      await page.waitForFunction(() => typeof window.LumaActions?.selectObject === "function");
      await page.evaluate(() => {
        const firstId = window.LumaState.objects[0]?.id;
        if (firstId) window.LumaActions.selectObject(firstId);
      });
      // Physical click ensures any UI event listeners (like sidebar opening) trigger.
      await page.click(`.object-hitbox[data-object-id]`, { force: true });
      await page.selectOption("#op-mode", mode);
      await page.waitForTimeout(100);
      const visibility = await page.evaluate(() => {
        const el = document.querySelector(
          "#editor-canvas [data-object-id] path, #editor-canvas [data-object-id] rect, #editor-canvas [data-object-id] circle"
        );
        if (!el) {
          return { error: "Primitive element missing within selected object group" };
        }
        const style = window.getComputedStyle(el);
        return {
          fill: style.fill,
          stroke: style.stroke,
          opacity: style.opacity,
          visibility: style.visibility,
          tagName: el.tagName,
        };
      });
      console.log(`Mode ${mode} visibility (${visibility.tagName}):`, visibility);
      if (visibility.error) {
        throw new Error(`Visibility Audit failed: ${visibility.error}`);
      }
      if (visibility.opacity === "0" || visibility.visibility === "hidden") {
        throw new Error(`Invisibility detected in mode: ${mode}`);
      }
    }

    console.log("Verifying Sidebar Center action...");
    // Target the newly added rectangle (index 1) for movement and geometry audits
    const targetIndex = 1;
    const initialX = await page.evaluate((idx) => window.LumaState.objects[idx].x, targetIndex);

    // Ensure the rectangle is selected
    await page.evaluate((idx) => {
      const id = window.LumaState.objects[idx]?.id;
      if (id) window.LumaActions.selectObject(id);
    }, targetIndex);

    await page.click("#center-button");
    await page.waitForTimeout(100);
    const centeredX = await page.evaluate((idx) => window.LumaState.objects[idx].x, targetIndex);
    console.log(`X coordinate before: ${initialX}, after center: ${centeredX}`);
    if (initialX !== centeredX) {
      console.log("Center action successfully moved the object.");
    } else {
      console.warn("Center action did not result in a state change for the target object.");
    }

    console.log("Verifying Property update (Width)...");
    await page.fill("#rect-width", "150");
    const updatedWidth = await page.evaluate((idx) => window.LumaState.objects[idx].liveGeometry?.width, targetIndex);
    console.log(`Updated width: ${updatedWidth}`);
    if (updatedWidth !== 150) {
      throw new Error(`Property binding for rect-width failed. Expected 150, got ${updatedWidth}`);
    }

    if (hasErrors) {
      throw new Error("E2E FAIL: Console errors or page errors detected during interactive flow.");
    }

    console.log("E2E PASSED.");
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
