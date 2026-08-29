/**
 * T21 proxy-key geo cache contracts (plan task 21, ADR-003).
 *
 * Contract surface (to be implemented by T21, asserted failing-first here):
 *   tools/playwright/shared/persona.js
 *     - resolvePersonaGeo(proxyKey, lookupGeo) -> resolves the proxy exit geo
 *       to a coherent { timezoneId, locale, acceptLanguage } triple, cached
 *       per proxy key so repeated resolution never performs duplicate geo
 *       lookups, with one fixed coherent fallback pair when geo cannot be
 *       resolved (lookup throws or resolves to null/undefined).
 */

import assert from "node:assert/strict";
import test from "node:test";

let personaModule = null;
let personaModuleError = null;
try {
  personaModule = await import("../shared/persona.js");
} catch (error) {
  personaModuleError = error;
}

function requireResolvePersonaGeo() {
  if (personaModuleError) {
    assert.fail(
      `T21 persona contract unavailable: shared/persona.js failed to load ` +
        `(${personaModuleError?.code || "ERR_MODULE_NOT_FOUND"}: ${personaModuleError?.message})`,
    );
  }
  const value = personaModule.resolvePersonaGeo;
  if (typeof value !== "function") {
    assert.fail(
      "T21 persona contract unavailable: shared/persona.js must export resolvePersonaGeo()",
    );
  }
  return value;
}

test("T21 repeated resolution for one proxy key performs exactly one geo lookup", async () => {
  const resolvePersonaGeo = requireResolvePersonaGeo();
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return { timezoneId: "Asia/Tokyo", locale: "ja-JP" };
  };

  const first = await resolvePersonaGeo("proxy:t21-tokyo", lookup);
  const second = await resolvePersonaGeo("proxy:t21-tokyo", lookup);

  assert.equal(
    lookups,
    1,
    "second resolution for the same proxy key must hit the cache",
  );
  assert.equal(first.timezoneId, "Asia/Tokyo");
  assert.equal(second.timezoneId, "Asia/Tokyo");
  assert.deepEqual(first, second);
  assert.equal(
    first.acceptLanguage?.split(",")[0],
    "ja-JP",
    "resolved Accept-Language must lead with the geo locale",
  );
});

test("T21 distinct proxy keys resolve their own geo independently", async () => {
  const resolvePersonaGeo = requireResolvePersonaGeo();
  let lookups = 0;
  const lookup = async () => {
    lookups += 1;
    return { timezoneId: "Europe/Madrid", locale: "es-ES" };
  };

  const first = await resolvePersonaGeo("proxy:t21-es", lookup);
  const second = await resolvePersonaGeo("proxy:t21-es-2", lookup);

  assert.equal(lookups, 2, "each distinct proxy key must resolve once");
  assert.equal(first.timezoneId, "Europe/Madrid");
  assert.equal(second.timezoneId, "Europe/Madrid");
});

test("T21 unresolvable geo falls back to one fixed coherent pair, cached per key", async () => {
  const resolvePersonaGeo = requireResolvePersonaGeo();
  let attempts = 0;
  const failingLookup = async () => {
    attempts += 1;
    throw new Error("geo upstream down");
  };

  const fallbackA = await resolvePersonaGeo("proxy:t21-fallback-a", failingLookup);
  const fallbackB = await resolvePersonaGeo("proxy:t21-fallback-b", failingLookup);

  assert.deepEqual(
    fallbackA,
    fallbackB,
    "fallback pair must be fixed, not per-key random",
  );
  assert.ok(fallbackA.locale, "fallback locale must be non-empty");
  assert.match(String(fallbackA.timezoneId), /^[A-Za-z_]+\//);
  assert.equal(
    fallbackA.acceptLanguage?.split(",")[0],
    fallbackA.locale,
    "fallback Accept-Language must be coherent with the fallback locale",
  );

  // Unresolved outcomes are cached too: the same key does not re-query.
  const cached = await resolvePersonaGeo("proxy:t21-fallback-a", failingLookup);
  assert.equal(
    attempts,
    2,
    "one lookup per distinct key even when geo cannot be resolved",
  );
  assert.deepEqual(cached, fallbackA);
});

test("T21 null geo results use the same fixed fallback pair as failures", async () => {
  const resolvePersonaGeo = requireResolvePersonaGeo();

  const fromNull = await resolvePersonaGeo("proxy:t21-null-geo", async () => null);
  const fromThrow = await resolvePersonaGeo(
    "proxy:t21-thrown-geo",
    async () => {
      throw new Error("geo upstream down");
    },
  );

  assert.deepEqual(fromNull, fromThrow);
  assert.ok(fromNull.locale, "fallback locale must be non-empty");
  assert.equal(
    fromNull.acceptLanguage?.split(",")[0],
    fromNull.locale,
    "fallback Accept-Language must be coherent with the fallback locale",
  );
});
