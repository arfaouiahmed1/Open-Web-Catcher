/**
 * navigate.js — URL navigation + redirect handling.
 *
 * CLI usage:
 *   node navigate.js '<json>'
 *
 * JSON payload:
 *   { browserWSEndpoint, url, waitUntil?, timeoutMs? }
 *
 * Output (stdout JSON):
 *   { success, finalUrl, title, status, redirectChain }
 */

"use strict";

const { connectBrowser, getPage } = require("./shared/browser");

async function main() {
  const params = JSON.parse(process.argv[2] || "{}");
  const {
    browserWSEndpoint,
    url,
    waitUntil = "networkidle2",
    timeoutMs = 30_000,
  } = params;

  if (!browserWSEndpoint) throw new Error("browserWSEndpoint is required");
  if (!url) throw new Error("url is required");

  const browser = await connectBrowser(browserWSEndpoint);
  const page = await getPage(browser);

  let status = null;
  const redirectChain = [];

  page.on("response", (res) => {
    const s = res.status();
    if (s >= 300 && s < 400) redirectChain.push(res.url());
    if (res.url() === url || redirectChain.length === 0) status = s;
  });

  let success = false;
  let errorMsg = null;

  try {
    await page.goto(url, { waitUntil, timeout: timeoutMs });
    success = true;
  } catch (e) {
    errorMsg = e.message;
  }

  const finalUrl = page.url();
  const title = await page.title().catch(() => "");

  await browser.disconnect();
  process.stdout.write(
    JSON.stringify({ success, finalUrl, title, status, redirectChain, error: errorMsg })
  );
}

main().catch((err) => {
  process.stderr.write(err.message + "\n");
  process.exit(1);
});
