import { chromium } from "playwright";
import fs from "fs";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto("file:///home/jeremiah/Summers%20Drive/Code/LumaBurn/index.html");
    await page.waitForTimeout(2000);
    
    // Check initial state
    const initialState = await page.evaluate(() => ({
      objects: state.objects.length,
      selected: state.selectedObjectIds
    }));
    console.log("Initial state:", initialState);

    // Click Add Rect
    await page.click("#add-rect-button");
    await page.waitForTimeout(1000);
    
    // Check post-add state
    const postAddState = await page.evaluate(() => ({
      objects: state.objects.length,
      selected: state.selectedObjectIds,
      activeRightTab: state.activeRightTab
    }));
    console.log("Post-add state:", postAddState);

    // Check visibility of fields and sliders
    const visibility = await page.evaluate(() => {
      const fields = document.querySelector("#inspector-fields");
      const imgBlock = document.querySelector("#inspector-image-block");
      const brightness = document.querySelector("#img-brightness");
      return {
        fields: !!fields && getComputedStyle(fields).display !== 'none',
        imgBlock: !!imgBlock && getComputedStyle(imgBlock).display !== 'none',
        brightness: !!brightness && getComputedStyle(brightness).display !== 'none'
      };
    });
    console.log("Visibility:", visibility);

    await page.screenshot({ path: "screenshot_final.png", fullPage: true });

  } catch (err) {
    console.error("Error during diagnosis:", err);
  } finally {
    await browser.close();
    console.log("Screenshots captured.");
  }
})();
