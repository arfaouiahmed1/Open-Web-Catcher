/**
 * T21 persistent browser-state contracts (plan task 21, ADR-003).
 *
 * Contract surface (to be implemented by T21, asserted failing-first here):
 *   tools/playwright/shared/browser-state.js
 *     - resolveBrowserStateDir({ profile, targetHost }) -> absolute directory
 *       under data/browser-state/<stable-hash>/ keyed by (profile,target-host).
 *   shared/browser.js (T21 behavior)
 *     - launchEphemeralBrowser(sessionId, { browserProfile, targetHost })
 *       launches through launchPersistentContext on that directory and
 *       closeEphemeralBrowser never deletes the persistent jar.
 *
 * The pure path-resolution tests run everywhere. The cookie-jar test needs a
 * real Chrome executable: it skips with an explicit reason only when no
 * runnable executable exists (env overrides first, then well-known install
 * locations); a launch failure against a runnable executable is a failure,
 * not a skip.
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

let stateModule = null;
let stateModuleError = null;
try {
  stateModule = await import("../shared/browser-state.js");
} catch (error) {
  stateModuleError = error;
}

function requireStateExport(name) {
  if (stateModuleError) {
    assert.fail(
      `T21 browser-state contract unavailable: shared/browser-state.js failed to load ` +
        `(${stateModuleError?.code || "ERR_MODULE_NOT_FOUND"}: ${stateModuleError?.message})`,
    );
  }
  const value = stateModule[name];
  if (typeof value !== "function") {
    assert.fail(
      `T21 browser-state contract unavailable: shared/browser-state.js must export ${name}()`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Real-browser gating (explicit, honest)
// ---------------------------------------------------------------------------

function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    const candidatePath = String(candidate || "").trim();
    if (!candidatePath) continue;
    try {
      if (fs.statSync(candidatePath).isFile()) return candidatePath;
    } catch {
      // keep probing
    }
  }
  return "";
}

function resolveRunnableChromeExecutable() {
  // Mirror shared/browser.js EXECUTABLE_PATH precedence first.
  const configured = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  ].filter(Boolean);
  if (configured.length) {
    const explicit = firstExistingFile(configured);
    return explicit
      ? { executable: explicit, reason: "" }
      : {
          executable: "",
          reason: `configured browser executable is not runnable: ${configured.join(", ")}`,
        };
  }

  // Then probe well-known per-OS Chrome installs so the launch assertions run
  // wherever any runnable Chrome exists.
  const wellKnown =
    process.platform === "win32"
      ? [
          path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
          path.join(process.env.LocalAppData || "", "Google", "Chrome", "Application", "chrome.exe"),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : [
            "/usr/local/bin/google-chrome-stable",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
          ];
  const found = firstExistingFile(wellKnown);
  return found
    ? { executable: found, reason: "" }
    : {
        executable: "",
        reason:
          "no runnable Chrome executable found (PLAYWRIGHT_EXECUTABLE_PATH unset and no well-known install present)",
      };
}

const chromeResolution = resolveRunnableChromeExecutable();
if (chromeResolution.executable) {
  // shared/browser.js captures EXECUTABLE_PATH at import time.
  process.env.PLAYWRIGHT_EXECUTABLE_PATH = chromeResolution.executable;
}

let browserModule = null;
let browserModuleError = null;
try {
  browserModule = await import("../shared/browser.js");
} catch (error) {
  browserModuleError = error;
}

// ---------------------------------------------------------------------------
// T21 contracts: stable per-(profile,target-host) state directories
// ---------------------------------------------------------------------------

test("T21 state directory is a stable hash under data/browser-state for one (profile,target-host)", () => {
  const resolveBrowserStateDir = requireStateExport("resolveBrowserStateDir");
  const input = { profile: "hosting", targetHost: "streaming.example" };

  const first = resolveBrowserStateDir(input);
  const second = resolveBrowserStateDir({ ...input });

  assert.ok(path.isAbsolute(first), `state dir must be absolute: ${first}`);
  const segments = first.replace(/[\\/]+$/, "").split(path.sep);
  assert.ok(
    segments.includes("data") && segments.includes("browser-state"),
    `state dir must live under data/browser-state/: ${first}`,
  );
  const hash = segments[segments.length - 1];
  assert.match(
    hash,
    /^[a-f0-9]{16,64}$/i,
    `state dir leaf must be a stable hex hash, got: ${hash}`,
  );
  assert.doesNotMatch(
    hash,
    /\d{13}/,
    "state dir leaf must not embed a millisecond timestamp",
  );
  assert.equal(
    first,
    second,
    "same (profile,target-host) must resolve to the identical directory",
  );
});

test("T21 different target hosts get separated state directories", () => {
  const resolveBrowserStateDir = requireStateExport("resolveBrowserStateDir");

  const hostA = resolveBrowserStateDir({
    profile: "hosting",
    targetHost: "alpha.example",
  });
  const hostB = resolveBrowserStateDir({
    profile: "hosting",
    targetHost: "beta.example",
  });

  assert.notEqual(hostA, hostB);
});

test("T21 different profiles get separated state directories on the same host", () => {
  const resolveBrowserStateDir = requireStateExport("resolveBrowserStateDir");

  const classification = resolveBrowserStateDir({
    profile: "classification",
    targetHost: "streaming.example",
  });
  const hosting = resolveBrowserStateDir({
    profile: "hosting",
    targetHost: "streaming.example",
  });

  assert.notEqual(classification, hosting);
});

// ---------------------------------------------------------------------------
// T21 contract: one persisted cookie jar per (profile,target-host)
// ---------------------------------------------------------------------------

test(
  "T21 two consecutive launches for one (profile,target-host) reuse the persisted cookie jar",
  {
    skip: chromeResolution.reason || false,
    timeout: 180000,
  },
  async () => {
    if (browserModuleError) {
      assert.fail(`shared/browser.js failed to load: ${browserModuleError.message}`);
    }
    const resolveBrowserStateDir = requireStateExport("resolveBrowserStateDir");
    const { launchEphemeralBrowser, closeEphemeralBrowser } = browserModule;

    const profile = "hosting";
    const targetHost = "t21-cookie-jar.example";
    const expectedDir = resolveBrowserStateDir({ profile, targetHost });

    const first = await launchEphemeralBrowser("t21-jar-first", {
      browserProfile: profile,
      targetHost,
    });
    try {
      const firstJar = first.stateDir ?? first.userDataDir;
      assert.equal(
        firstJar,
        expectedDir,
        "launch must use the persistent state dir for (profile,target-host)",
      );
      await first.context.addCookies([
        { name: "owc_t21_jar", value: "persisted", url: `https://${targetHost}` },
      ]);
    } finally {
      await closeEphemeralBrowser(first);
    }

    assert.ok(
      fs.existsSync(expectedDir),
      "persistent jar must survive closeEphemeralBrowser (no rm -rf cleanup)",
    );

    const second = await launchEphemeralBrowser("t21-jar-second", {
      browserProfile: profile,
      targetHost,
    });
    try {
      assert.equal(
        second.stateDir ?? second.userDataDir,
        expectedDir,
        "second launch must reuse the same persistent jar",
      );
      const cookies = await second.context.cookies(`https://${targetHost}`);
      const persisted = cookies.find((cookie) => cookie.name === "owc_t21_jar");
      assert.ok(
        persisted,
        `cookie written by the first launch must be visible in the second; saw: ${JSON.stringify(cookies)}`,
      );
      assert.equal(persisted.value, "persisted");
    } finally {
      await closeEphemeralBrowser(second);
    }
  },
);
