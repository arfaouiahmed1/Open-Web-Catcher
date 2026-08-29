/**
 * T21 deterministic browser persona (plan task 21, ADR-003).
 *
 * One atomic, coherent Windows 11 x64 desktop persona:
 *   - version-matched Chrome user agent + client-hint brands;
 *   - timezone / locale / Accept-Language bound to the proxy exit geo;
 *   - no dnt header.
 *
 * `buildPersona` is pure: identical inputs always produce an identical
 * persona. `resolvePersonaGeo` caches the resolved (or fallback) geo per
 * normalized proxy key so repeated resolution never performs duplicate
 * upstream lookups.
 */

import { selectPersistentFingerprintHeaders } from "../../shared/fingerprint-headers.js";

// Windows 11 reports UA-CH platformVersion >= 13 while the user agent string
// stays frozen at "Windows NT 10.0". Kept as a bare major so consumers can
// compare it numerically.
const WINDOWS_PLATFORM_VERSION = "13";
const DEFAULT_CHROME_VERSION = "146.0.0.0";

// Fixed coherent fallback pair used whenever the proxy exit geo cannot be
// resolved (lookup throws, resolves to null/undefined, or omits a field).
const FALLBACK_GEO = Object.freeze({
  timezoneId: "America/New_York",
  locale: "en-US",
});

// Resolved outcomes (success and fallback alike) are cached per proxy key.
const geoCacheByProxyKey = new Map();

function getChromeMajorVersion(version) {
  const major = Number.parseInt(String(version || "").split(".")[0] || "", 10);
  if (Number.isFinite(major) && major > 0) return String(major);
  return String(DEFAULT_CHROME_VERSION.split(".")[0]);
}

function buildChromeBrands(majorVersion) {
  return [
    { brand: "Not.A/Brand", version: "99" },
    { brand: "Chromium", version: majorVersion },
    { brand: "Google Chrome", version: majorVersion },
  ];
}

function buildSecChUa(brands) {
  return brands
    .map((entry) => `"${entry.brand}";v="${entry.version}"`)
    .join(", ");
}

function normalizeLocale(locale) {
  const value = String(locale || "").trim();
  return value || FALLBACK_GEO.locale;
}

function localeChain(locale) {
  const [primary, region] = locale.split("-");
  if (!region) return [locale];
  return [`${primary}-${region}`, primary];
}

function buildAcceptLanguage(locale) {
  const chain = localeChain(locale);
  if (chain.length < 2) return chain[0];
  return `${chain[0]},${chain[1]};q=0.9`;
}

/**
 * Build one deterministic Windows 11 x64 persona for the given Chrome
 * version and proxy exit geo.
 *
 * @param {{ chromeVersion?: string, geo?: { timezoneId?: string, locale?: string } | null }} options
 * @returns {{
 *   userAgent: string,
 *   platform: string,
 *   languages: string[],
 *   locale: string,
 *   timezoneId: string,
 *   acceptLanguage: string,
 *   headers: Record<string, string>,
 *   userAgentMetadata: object,
 * }}
 */
export function buildPersona({ chromeVersion, geo } = {}) {
  const effectiveChromeVersion =
    String(chromeVersion || "").trim() || DEFAULT_CHROME_VERSION;
  const chromeMajorVersion = getChromeMajorVersion(effectiveChromeVersion);

  const source = geo && typeof geo === "object" ? geo : {};
  const timezoneId =
    typeof source.timezoneId === "string" && source.timezoneId.trim()
      ? source.timezoneId.trim()
      : FALLBACK_GEO.timezoneId;
  const locale = normalizeLocale(source.locale);
  const languages = localeChain(locale);
  const acceptLanguage = buildAcceptLanguage(locale);

  const brands = buildChromeBrands(chromeMajorVersion);
  const fullVersionList = brands.map((entry) => ({
    ...entry,
    version: effectiveChromeVersion,
  }));
  const userAgent = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "AppleWebKit/537.36 (KHTML, like Gecko)",
    `Chrome/${effectiveChromeVersion}`,
    "Safari/537.36",
  ].join(" ");

  const headers = selectPersistentFingerprintHeaders({
    "user-agent": userAgent,
    "accept-language": acceptLanguage,
    "sec-ch-ua": buildSecChUa(brands),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-ch-ua-platform-version": `"${WINDOWS_PLATFORM_VERSION}"`,
    "sec-ch-ua-full-version-list": fullVersionList
      .map((entry) => `"${entry.brand}";v="${entry.version}"`)
      .join(", "),
    "sec-ch-ua-arch": '"x86"',
    "sec-ch-ua-bitness": '"64"',
  });

  return {
    userAgent,
    platform: "Win32",
    languages,
    locale,
    timezoneId,
    acceptLanguage,
    headers,
    userAgentMetadata: {
      brands,
      fullVersion: effectiveChromeVersion,
      fullVersionList,
      platform: "Windows",
      platformVersion: WINDOWS_PLATFORM_VERSION,
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
  };
}

function normalizeGeoResult(value) {
  const source = value && typeof value === "object" ? value : {};
  const timezoneId =
    typeof source.timezoneId === "string" && source.timezoneId.trim()
      ? source.timezoneId.trim()
      : FALLBACK_GEO.timezoneId;
  const locale = normalizeLocale(source.locale);
  return { timezoneId, locale, acceptLanguage: buildAcceptLanguage(locale) };
}

/**
 * Resolve the proxy exit geo for a proxy key, cached per normalized key so
 * repeated resolution performs exactly one lookup. Unresolvable geos
 * (lookup throws or resolves to null/undefined) fall back to one fixed
 * coherent pair, which is cached too.
 *
 * @param {string} proxyKey
 * @param {(proxyKey: string) => Promise<{ timezoneId?: string, locale?: string } | null> | { timezoneId?: string, locale?: string } | null} lookupGeo
 * @returns {Promise<{ timezoneId: string, locale: string, acceptLanguage: string }>}
 */
export async function resolvePersonaGeo(proxyKey, lookupGeo) {
  const cacheKey = String(proxyKey ?? "").trim().toLowerCase();
  if (geoCacheByProxyKey.has(cacheKey)) {
    return geoCacheByProxyKey.get(cacheKey);
  }

  // Cache the promise itself so concurrent callers for the same key share a
  // single lookup, and fallback outcomes stay cached after resolution.
  const pending = (async () => {
    try {
      if (typeof lookupGeo !== "function") {
        throw new Error("resolvePersonaGeo requires an async lookupGeo");
      }
      return normalizeGeoResult(await lookupGeo(proxyKey));
    } catch {
      return normalizeGeoResult(null);
    }
  })();
  geoCacheByProxyKey.set(cacheKey, pending);
  return pending;
}
