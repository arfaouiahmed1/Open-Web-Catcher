/**
 * inspect.js — DOM scan + element extraction + screenshot.
 *
 * CLI usage:
 *   node inspect.js '<json>'
 *
 * JSON payload:
 *   { browserWSEndpoint, selector?, includeScreenshot? }
 *
 * Output (stdout JSON):
 *   { title, url, elements: [...], iframes: [...], screenshotUrl? }
 */

"use strict";

const { connectBrowser, getPage } = require("./shared/browser");
const { screenshotViewport } = require("./shared/screenshot");

async function main() {
  const params = JSON.parse(process.argv[2] || "{}");
  const {
    browserWSEndpoint,
    selector = "body",
    includeScreenshot = true,
  } = params;

  if (!browserWSEndpoint) throw new Error("browserWSEndpoint is required");

  const browser = await connectBrowser(browserWSEndpoint);
  const page = await getPage(browser);

  const title = await page.title();
  const url = page.url();

  // Extract visible interactive elements
  const elements = await page.evaluate((sel) => {
    const root = document.querySelector(sel) || document.body;
    const tags = ["a", "button", "video", "iframe", "source", "input", "select"];
    const results = [];
    tags.forEach((tag) => {
      root.querySelectorAll(tag).forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return; // skip invisible
        results.push({
          tag,
          text: el.innerText?.trim().slice(0, 120) || "",
          href: el.href || "",
          src: el.src || el.currentSrc || "",
          type: el.type || "",
          name: el.name || "",
          id: el.id || "",
          className: el.className?.toString().trim().slice(0, 80) || "",
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        });
      });
    });
    return results;
  }, selector);

  // List iframes with src
  const iframes = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map((f) => ({
      src: f.src || f.getAttribute("data-src") || "",
      id: f.id || "",
      name: f.name || "",
    }))
  );

  const result = { title, url, elements, iframes };

  if (includeScreenshot) {
    try {
      result.screenshotUrl = await screenshotViewport(page);
    } catch (e) {
      result.screenshotError = e.message;
    }
  }

  await browser.disconnect();
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
