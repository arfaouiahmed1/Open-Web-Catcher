/**
 * interact.js — Click / play / type / select / coordinates + anti-bot evasion.
 *
 * CLI usage:
 *   node interact.js '<json>'
 *
 * JSON payload:
 *   { browserWSEndpoint, action, selector?, value?, x?, y? }
 *
 * actions: "click" | "play" | "type" | "select" | "coordinates"
 *
 * Output (stdout JSON):
 *   { success, action, url, title, error? }
 */

"use strict";

const { connectBrowser, getPage } = require("./shared/browser");

/** Human-like delay between min and max ms */
function randomDelay(min = 80, max = 300) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

async function main() {
  const params = JSON.parse(process.argv[2] || "{}");
  const { browserWSEndpoint, action = "click", selector = "", value = "", x, y } = params;

  if (!browserWSEndpoint) throw new Error("browserWSEndpoint is required");

  const browser = await connectBrowser(browserWSEndpoint);
  const page = await getPage(browser);

  let success = false;
  let error = null;

  try {
    switch (action) {
      case "click": {
        const el = await page.waitForSelector(selector, { timeout: 10_000 });
        await randomDelay();
        await el.click();
        success = true;
        break;
      }

      case "play": {
        // Try standard play button selectors, then trigger video.play()
        const playSelectors = [
          selector,
          ".play-button",
          "[data-plyr='play']",
          ".vjs-play-button",
          "button[aria-label*='play' i]",
        ].filter(Boolean);

        let played = false;
        for (const sel of playSelectors) {
          try {
            const el = await page.$(sel);
            if (el) {
              await randomDelay();
              await el.click();
              played = true;
              break;
            }
          } catch (_) {}
        }

        if (!played) {
          // Fallback: call video.play() via JS
          await page.evaluate(() => {
            const v = document.querySelector("video");
            if (v) v.play();
          });
        }
        success = true;
        break;
      }

      case "type": {
        const el = await page.waitForSelector(selector, { timeout: 10_000 });
        await el.click();
        await randomDelay(50, 100);
        await el.type(value, { delay: 50 + Math.random() * 80 });
        success = true;
        break;
      }

      case "select": {
        await page.select(selector, value);
        success = true;
        break;
      }

      case "coordinates": {
        if (x == null || y == null) throw new Error("x and y are required for coordinates action");
        await randomDelay();
        await page.mouse.move(x, y, { steps: 5 });
        await randomDelay(50, 120);
        await page.mouse.click(x, y);
        success = true;
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }

    // Short wait for any network/render activity after interaction
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5_000 }).catch(() => {});
  } catch (e) {
    error = e.message;
  }

  await browser.disconnect();
  process.stdout.write(
    JSON.stringify({ success, action, url: page.url(), title: await page.title().catch(() => ""), error })
  );
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
