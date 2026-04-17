import test from "node:test";
import assert from "node:assert";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Helper to find an open port
function getFreePort() {
  return new Promise((res) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

test("LumaBurn Layout Integrity Audit", async (t) => {
  const port = await getFreePort();
  const server = spawn("node", ["server.cjs"], {
    env: { ...process.env, PORT: port.toString() },
    stdio: "pipe",
  });

  // Wait for server to be ready
  await new Promise((resolve) => {
    server.stdout.on("data", (data) => {
      if (data.toString().includes("Server running")) resolve();
    });
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await t.test("Structural Hierarchy: Header should be above Body", async () => {
    await page.goto(`http://localhost:${port}`);
    await page.waitForSelector(".app-header");
    
    const headerBox = await page.locator(".app-header").boundingBox();
    const bodyBox = await page.locator(".app-body").boundingBox();
    const menubarBox = await page.locator(".app-menubar").boundingBox();

    assert.ok(menubarBox.y === 0, "Menubar should be at the very top (Y=0)");
    assert.ok(headerBox.y >= menubarBox.height, "Header should be below Menubar");
    assert.ok(bodyBox.y >= headerBox.y + headerBox.height, "Body should be below Header");
  });

  await t.test("Width Consistency: Main panels should span full viewport", async () => {
    const viewport = page.viewportSize();
    const headerBox = await page.locator(".app-header").boundingBox();
    const menubarBox = await page.locator(".app-menubar").boundingBox();

    // Allow for small rounding differences (2px for borders/scrollbars)
    assert.ok(Math.abs(headerBox.width - viewport.width) <= 2, "Header should span full viewport width");
    assert.ok(Math.abs(menubarBox.width - viewport.width) <= 2, "Menubar should span full viewport width");
  });

  await browser.close();
  server.kill();
});
