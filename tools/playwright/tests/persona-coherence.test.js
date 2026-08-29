/**
 * T21 persona-coherence contracts (plan task 21, ADR-003).
 *
 * Contract surface (to be implemented by T21, asserted failing-first here):
 *   tools/playwright/shared/persona.js
 *     - buildPersona({ chromeVersion, geo }) -> one atomic, deterministic
 *       Windows 11 x64 persona: version-matched Chrome UA + client-hint
 *       brands, coherent timezone/locale/Accept-Language, no dnt.
 *     - resolvePersonaGeo(proxyKey, lookupGeo) -> proxy-exit geo cached per
 *       proxy key with a fixed coherent fallback pair.
 *
 * Tests labeled "baseline" characterize CURRENT pre-T21 behavior so the T21
 * diff shows exactly what flips; they must be updated together with the
 * production change they document. All other tests are the T21 contracts and
 * are expected to fail until shared/persona.js exists.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { selectPersistentFingerprintHeaders } from "../../shared/fingerprint-headers.js";

const CHROME_VERSION = "149.0.7827.115";
const CHROME_MAJOR = "149";
const CHROME_VERSION_PATTERN = new RegExp(
  `Chrome/${CHROME_VERSION.replace(/\./g, "\\.")}(\\s|$)`,
);

// Dynamic import so baseline characterization still runs while the T21 module
// is missing; each contract test then fails with an explicit message instead
// of a loader crash that would hide the rest of the file.
let personaModule = null;
let personaModuleError = null;
try {
  personaModule = await import("../shared/persona.js");
} catch (error) {
  personaModuleError = error;
}

function requirePersonaExport(name) {
  if (personaModuleError) {
    assert.fail(
      `T21 persona contract unavailable: shared/persona.js failed to load ` +
        `(${personaModuleError?.code || "ERR_MODULE_NOT_FOUND"}: ${personaModuleError?.message})`,
    );
  }
  const value = personaModule[name];
  if (typeof value !== "function") {
    assert.fail(
      `T21 persona contract unavailable: shared/persona.js must export ${name}()`,
    );
  }
  return value;
}

function lowerCaseHeaders(headers) {
  const normalized = {};
  for (const [name, value] of Object.entries(headers || {})) {
    normalized[String(name).toLowerCase()] = String(value);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Baseline characterization (current pre-T21 behavior)
// ---------------------------------------------------------------------------

test("T21: persistent header allowlist excludes dnt", () => {
  const headers = selectPersistentFingerprintHeaders({
    dnt: "1",
    "user-agent": "Chrome/149",
    "sec-fetch-mode": "navigate",
  });

  assert.equal("dnt" in headers, false);
  assert.equal(headers["user-agent"], "Chrome/149");
  assert.equal("sec-fetch-mode" in headers, false);
});

test("baseline: browser.js keeps the T20 public lifecycle surface", async () => {
  let browserModule;
  try {
    browserModule = await import("../shared/browser.js");
  } catch (error) {
    assert.fail(`shared/browser.js must stay importable: ${error?.message}`);
  }

  for (const name of [
    "connectBrowser",
    "launchEphemeralBrowser",
    "closeEphemeralBrowser",
    "getPage",
    "getPageNetworkDiagnostics",
    "getIframeDiagnostics",
    "retryNavigationAfterAutoRecovery",
    "ensureStreamCorsInjection",
    "enforceWindowBounds",
  ]) {
    assert.equal(
      typeof browserModule[name],
      "function",
      `browser.js must keep exporting ${name}()`,
    );
  }
});

// ---------------------------------------------------------------------------
// T21 contracts (failing-first until shared/persona.js lands)
// ---------------------------------------------------------------------------

test("T21 persona builder emits one atomic coherent Windows 11 x64 persona", () => {
  const buildPersona = requirePersonaExport("buildPersona");
  const persona = buildPersona({ chromeVersion: CHROME_VERSION, geo: null });

  // User agent: version-matched Chrome on Windows x64.
  assert.match(String(persona.userAgent), /Windows NT 10\.0; Win64; x64/);
  assert.match(String(persona.userAgent), CHROME_VERSION_PATTERN);
  assert.equal(persona.platform, "Win32");

  // Client-hint metadata: Windows 11 x64 desktop.
  const meta = persona.userAgentMetadata || {};
  assert.equal(meta.platform, "Windows");
  assert.ok(
    Number(meta.platformVersion) >= 13,
    `Win11 platformVersion expected (>=13), got ${meta.platformVersion}`,
  );
  assert.equal(meta.architecture, "x86");
  assert.equal(meta.bitness, "64");
  assert.equal(meta.mobile, false);

  // Brands match the effective Chrome major version; full list matches the
  // full Chrome version.
  const brands = Array.isArray(meta.brands) ? meta.brands : [];
  assert.deepEqual(
    brands
      .filter((entry) => ["Chromium", "Google Chrome"].includes(entry.brand))
      .map((entry) => [entry.brand, String(entry.version)])
      .sort(),
    [
      ["Chromium", CHROME_MAJOR],
      ["Google Chrome", CHROME_MAJOR],
    ].sort(),
  );
  const fullVersionList = Array.isArray(meta.fullVersionList)
    ? meta.fullVersionList
    : [];
  for (const entry of fullVersionList.filter((candidate) =>
    ["Chromium", "Google Chrome"].includes(candidate.brand),
  )) {
    assert.equal(
      String(entry.version),
      CHROME_VERSION,
      "fullVersionList entries must carry the full Chrome version",
    );
  }

  // Headers agree with the navigator-level persona and carry no dnt.
  const headers = lowerCaseHeaders(persona.headers);
  assert.equal(headers["user-agent"], persona.userAgent);
  assert.equal(headers["sec-ch-ua-mobile"], "?0");
  assert.equal(headers["sec-ch-ua-platform"], '"Windows"');
  assert.ok(
    headers["sec-ch-ua"]?.includes('"Chromium";v="149"'),
    `sec-ch-ua must pin Chromium at the matched major: ${headers["sec-ch-ua"]}`,
  );
  assert.ok(
    headers["sec-ch-ua"]?.includes('"Google Chrome";v="149"'),
    `sec-ch-ua must pin Google Chrome at the matched major: ${headers["sec-ch-ua"]}`,
  );
  assert.equal(
    "dnt" in headers,
    false,
    "T21 personas must not send a dnt header",
  );

  // Locale chain is coherent end to end and the timezone is IANA-shaped.
  assert.equal(persona.languages?.[0], persona.locale);
  assert.equal(
    headers["accept-language"]?.split(",")[0],
    persona.locale,
    "Accept-Language primary tag must equal the persona locale",
  );
  assert.match(String(persona.timezoneId), /^[A-Za-z_]+\/[A-Za-z_]+$/);
});

test("T21 persona binds timezone, locale and Accept-Language to the proxy exit geo", () => {
  const buildPersona = requirePersonaExport("buildPersona");
  const persona = buildPersona({
    chromeVersion: CHROME_VERSION,
    geo: { timezoneId: "Europe/Berlin", locale: "de-DE" },
  });

  assert.equal(persona.timezoneId, "Europe/Berlin");
  assert.equal(persona.locale, "de-DE");
  assert.equal(persona.languages?.[0], "de-DE");

  const headers = lowerCaseHeaders(persona.headers);
  assert.ok(
    headers["accept-language"]?.startsWith("de-DE"),
    `Accept-Language must lead with the geo locale: ${headers["accept-language"]}`,
  );
});

test("T21 persona building is deterministic for identical inputs", () => {
  const buildPersona = requirePersonaExport("buildPersona");
  const geo = { timezoneId: "America/New_York", locale: "en-US" };

  assert.deepEqual(
    buildPersona({ chromeVersion: CHROME_VERSION, geo }),
    buildPersona({ chromeVersion: CHROME_VERSION, geo }),
  );
});
