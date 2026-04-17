import { chromium } from "playwright";
import http from "http";
import { spawn } from "child_process";

async function run() {
    console.log("Starting LumaBurn server...");
    const server = spawn("node", ["server.cjs"], { env: { ...process.env, PORT: "4174" } });
    
    await new Promise(res => setTimeout(res, 1000));
    
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    console.log("Navigating to app...");
    await page.goto("http://localhost:4174");
    
    const audit = await page.evaluate(() => {
        if (!window.LumaElements) return { error: "LumaElements missing" };
        const failures = Object.entries(window.LumaElements)
          .filter(([key, el]) => el === null && !["imgFilterRed", "imgFilterGreen", "imgFilterBlue"].includes(key))
          .map(([key]) => key);
        return { failures };
    });
    
    console.log("Element Binding Audit Result:", JSON.stringify(audit, null, 2));
    
    await browser.close();
    server.kill();
    process.exit(0);
}

run();
