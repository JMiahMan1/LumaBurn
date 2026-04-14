import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  console.log("Launching browser...");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('console', msg => {
    console.log(`BROWSER CONSOLE [${msg.type()}]: ${msg.text()}`);
  });
  
  page.on('pageerror', err => {
    console.error(`BROWSER ERROR: ${err.message}`);
  });

  console.log("Navigating to LumaBurn...");
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'load' });

  console.log("Creating test SVG...");
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="red"/></svg>`;
  fs.writeFileSync('test.svg', svgContent);

  console.log("Uploading test SVG...");
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) {
    await fileInput.setInputFiles('test.svg');
  } else {
    console.log("Using JS to trigger upload because file input is hidden or handled differently...");
    await page.evaluate(() => {
      // Create a file and trigger the loadSvgDocument or import handling
      const file = new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="red"/></svg>'], 'test.svg', { type: 'image/svg+xml' });
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      
      const fileInput = document.getElementById('file-upload') || document.querySelector('input[type="file"]');
      if (fileInput) {
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
         console.error("Could not find file input element.");
      }
    });
  }

  await page.waitForTimeout(2000); // give time for import and errors
  
  console.log("Checking if import succeeded...");
  const objectsLen = await page.evaluate(() => window.LumaState?.objects?.length);
  console.log(`window.LumaState.objects.length = ${objectsLen}`);
  
  if (objectsLen > 0) {
    console.log("Success! state.objects length > 0");
  } else {
    throw new Error("E2E FAIL: No objects found in state after upload.");
  }
  
  await browser.close();
})();
