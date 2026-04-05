/**
 * screenshot.js — Quick screenshot capture + Cloudinary upload.
 *
 * CLI usage:
 *   node screenshot.js '<json>'
 *
 * JSON payload:
 *   { browserWSEndpoint, mode?, selector? }
 *   mode: "full" | "viewport" | "player"
 *
 * Output (stdout JSON):
 *   { screenshotUrl, mode }
 */

"use strict";

const { connectBrowser, getPage } = require("./shared/browser");
const { screenshotFull, screenshotViewport, screenshotPlayer } = require("./shared/screenshot");

async function main() {
  const params = JSON.parse(process.argv[2] || "{}");
  const { browserWSEndpoint, mode = "viewport", selector = "video" } = params;

  if (!browserWSEndpoint) throw new Error("browserWSEndpoint is required");

  const browser = await connectBrowser(browserWSEndpoint);
  const page = await getPage(browser);

  let screenshotUrl;
  switch (mode) {
    case "full":
      screenshotUrl = await screenshotFull(page);
      break;
    case "player":
      screenshotUrl = await screenshotPlayer(page, selector);
      break;
    case "viewport":
    default:
      screenshotUrl = await screenshotViewport(page);
      break;
  }

  await browser.disconnect();
  process.stdout.write(JSON.stringify({ screenshotUrl, mode }));
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
