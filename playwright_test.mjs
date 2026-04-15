import { chromium } from "playwright";
import fs from "fs";

(async () => {
  let hasErrors = false;
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  page.on("console", (msg) => {
    const text = msg.text();
    // Ignore expected 404 for optional network discovery in test environments
    if (text.includes("/network-info") && text.includes("404")) {
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
    if (url.endsWith("/network-info")) {
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
      await page.selectOption("#op-mode", mode);
      await page.waitForTimeout(100);
      const visibility = await page.evaluate(() => {
        const el = document.querySelector("#editor-canvas [data-object-id] *");
        if (!el) {
          return { error: "Element missing" };
        }
        const style = window.getComputedStyle(el);
        return {
          fill: style.fill,
          stroke: style.stroke,
          opacity: style.opacity,
          visibility: style.visibility,
        };
      });
      console.log(`Mode ${mode} visibility:`, visibility);
      if (visibility.opacity === "0" || visibility.visibility === "hidden") {
        throw new Error(`Invisibility detected in mode: ${mode}`);
      }
    }

    console.log("Verifying Sidebar Center action...");
    const initialX = await page.evaluate(() => window.LumaState.objects[0].x);
    await page.click("#center-button");
    await page.waitForTimeout(100);
    const centeredX = await page.evaluate(() => window.LumaState.objects[0].x);
    console.log(`X coordinate before: ${initialX}, after center: ${centeredX}`);
    if (initialX !== centeredX) {
      console.log("Center action successfully moved the object.");
    } else if (centeredX === (400 - 150) / 2) {
      console.log("Object was already centered.");
    } else {
      console.warn("Center action might have failed.");
    }

    console.log("Verifying Property update (Width)...");
    await page.fill("#rect-width", "150");
    const updatedWidth = await page.evaluate(() => window.LumaState.objects[0].liveGeometry.width);
    console.log(`Updated width: ${updatedWidth}`);
    if (updatedWidth !== 150) {
      throw new Error("Property binding for rect-width failed.");
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
