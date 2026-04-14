import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

test('Application Sanity: Initial Load and API presence', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().includes('favicon')) {
      consoleErrors.push(msg.text());
    }
  });
  
  page.on('pageerror', err => {
    consoleErrors.push(err.message);
  });

  try {
    // Navigate to the app (assumes dev server is running)
    await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });

    // Check for critical globals
    const globals = await page.evaluate(() => {
      return {
        LumaState: !!window.LumaState,
        LumaActions: !!window.LumaActions,
        LumaElements: !!window.LumaElements,
      };
    });

    assert.ok(globals.LumaState, 'LumaState should be globally available');
    assert.ok(globals.LumaActions, 'LumaActions should be globally available');
    assert.ok(globals.LumaElements, 'LumaElements should be globally available');
    
    // Check for zero errors on load
    assert.equal(consoleErrors.length, 0, `App loaded with console errors: ${consoleErrors.join(', ')}`);

  } finally {
    await browser.close();
  }
});
