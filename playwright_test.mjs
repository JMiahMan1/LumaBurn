import { chromium } from 'playwright';
import fs from 'fs';

(async () => {
  let hasErrors = false;
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('console', msg => {
    const text = msg.text();
    console.log(`BROWSER CONSOLE [${msg.type()}]: ${text}`);
    if (msg.type() === 'error' && !text.includes('favicon')) {
      console.error('FAIL: Detected console error during test.');
      hasErrors = true;
    }
  });
  
  page.on('pageerror', err => {
    console.error(`BROWSER ERROR: ${err.message}`);
    hasErrors = true;
  });

  try {
    console.log('Navigating to LumaBurn...');
    await page.goto('http://127.0.0.1:4173', { waitUntil: 'load' });

    console.log('Creating test SVG...');
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="red"/></svg>';
    fs.writeFileSync('test.svg', svgContent);

    console.log('Uploading test SVG...');
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    await page.evaluate(({ dt, content }) => {
      const file = new File([content], 'test.svg', { type: 'image/svg+xml' });
      dt.items.add(file);
    }, { dt: dataTransfer, content: svgContent });

    const fileInput = await page.$('input[type="file"]');
    await fileInput.setInputFiles('test.svg');

    console.log('Waiting for import processing...');
    await page.waitForTimeout(1000);
    
    console.log('Verifying state population...');
    const objectsLen = await page.evaluate(() => window.LumaState?.objects?.length);
    console.log(`window.LumaState.objects.length = ${objectsLen}`);
    
    if (objectsLen === 1) {
      console.log('Success: 1 object imported.');
    } else {
      throw new Error(`Expected 1 object, found ${objectsLen}`);
    }

    console.log('Verifying functional interaction (Property change)...');
    await page.evaluate(() => {
      const obj = window.LumaState.objects[0];
      obj.power = 85;
      window.LumaActions.render(); // Force a render to check for crashes
    });
    
    await page.waitForTimeout(500);
    
    if (hasErrors) {
      throw new Error('E2E FAIL: Console errors or page errors detected.');
    }
    
    console.log('E2E PASSED.');

  } catch (err) {
    console.error(`E2E FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
    if (fs.existsSync('test.svg')) fs.unlinkSync('test.svg');
    if (hasErrors) process.exit(1);
  }
})();
