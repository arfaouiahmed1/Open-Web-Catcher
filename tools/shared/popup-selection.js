const BLANK_URLS = new Set(["", "about:blank", "about:newtab"]);
const PLAYER_HINT = /(embed|live|media|play|player|stream|video|watch|webplayer)/i;
const HTTP_URL = /https?:\/\/[^\s"'<>\\]+/gi;
const AD_HINT =
  /(^|[./_-])(ad[sx]?|advert|banner|click|doubleclick|download|offer|pop(ad|under|up)?|promo|push|redirect|sponsor|telegram)([./?&=_-]|$)/i;

export function isBlankPopupUrl(url) {
  return BLANK_URLS.has(String(url || "").trim().toLowerCase());
}

function sameOrigin(url, openerUrl) {
  try {
    const popup = new URL(url);
    const opener = new URL(openerUrl);
    return popup.origin === opener.origin;
  } catch {
    return false;
  }
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function decodeBase64Chunk(value) {
  const raw = String(value || "").trim();
  if (raw.length < 12 || !/^[A-Za-z0-9+/_=-]+$/.test(raw)) return "";
  const padded = raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), "=");
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function cleanupExtractedUrl(value) {
  return String(value || "")
    .replace(/[),.;\]\u060c\u061b]+$/u, "")
    .trim();
}

function extractUrlsFromText(text) {
  const urls = [];
  for (const match of String(text || "").matchAll(HTTP_URL)) {
    const url = cleanupExtractedUrl(match[0]);
    if (url) urls.push(url);
  }
  return urls;
}

export function extractPopupPlayerUrls(candidate = {}) {
  const rawUrls = [
    candidate?.initial_url,
    candidate?.initialUrl,
    candidate?.final_url,
    candidate?.finalUrl,
    candidate?.url,
  ].filter(Boolean);
  const popupUrlSet = new Set(rawUrls.map((url) => String(url || "").trim().toLowerCase()));
  const evidenceValues = [];

  for (const rawUrl of rawUrls) {
    const url = String(rawUrl || "");
    evidenceValues.push(url, safeDecodeURIComponent(url));

    try {
      const parsed = new URL(url);
      for (const pair of parsed.search.replace(/^\?/, "").split("&")) {
        const [, ...rawValueParts] = pair.split("=");
        const rawValue = rawValueParts.join("=");
        if (!rawValue) continue;
        evidenceValues.push(rawValue, safeDecodeURIComponent(rawValue));
        for (const chunk of rawValue.split(/_{2,}/)) {
          evidenceValues.push(decodeBase64Chunk(chunk));
          evidenceValues.push(decodeBase64Chunk(safeDecodeURIComponent(chunk)));
        }
      }
      parsed.searchParams.forEach((value) => {
        evidenceValues.push(value, safeDecodeURIComponent(value));
        for (const chunk of String(value || "").split(/_{2,}/)) {
          evidenceValues.push(decodeBase64Chunk(chunk));
          evidenceValues.push(decodeBase64Chunk(safeDecodeURIComponent(chunk)));
        }
      });
      if (parsed.hash) {
        const hashValue = parsed.hash.slice(1);
        evidenceValues.push(hashValue, safeDecodeURIComponent(hashValue));
        for (const chunk of hashValue.split(/_{2,}/)) {
          evidenceValues.push(decodeBase64Chunk(chunk));
          evidenceValues.push(decodeBase64Chunk(safeDecodeURIComponent(chunk)));
        }
      }
    } catch {
      // The raw string can still contain URL evidence even when URL parsing fails.
    }
  }

  const seen = new Set();
  const extracted = [];
  for (const value of evidenceValues) {
    for (const url of extractUrlsFromText(value)) {
      const normalized = url.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      extracted.push(url);
    }
  }

  if (!extracted.some((url) => PLAYER_HINT.test(url))) {
    return [];
  }

  return extracted
    .filter((url) => !popupUrlSet.has(url.toLowerCase()))
    .filter((url) => !AD_HINT.test(url))
    .slice(0, 8);
}

export function classifyPopupCandidate(candidate, openerUrl = "") {
  const initialUrl = String(candidate?.initial_url || candidate?.initialUrl || "").trim();
  const finalUrl = String(candidate?.final_url || candidate?.finalUrl || candidate?.url || "").trim();
  const url = finalUrl || initialUrl;
  const title = String(candidate?.title || "").trim();
  const haystack = `${url} ${title}`.toLowerCase();
  const same_origin = sameOrigin(url, openerUrl || candidate?.opener_url || candidate?.openerUrl || "");
  const extracted_player_urls = extractPopupPlayerUrls(candidate);

  if (isBlankPopupUrl(url)) {
    return {
      classification: "blank",
      adoptable: false,
      target_decision: "ignore_blank",
      reason: "blank_or_unresolved_popup",
      same_origin,
    };
  }

  if (extracted_player_urls.length > 0) {
    return {
      classification: same_origin ? "same_origin_encoded_player" : "encoded_player_redirect",
      adoptable: true,
      target_decision: "adopt_same_content_player",
      reason: same_origin ? "same_origin_encoded_player_url_signal" : "encoded_player_url_signal",
      same_origin,
      extracted_player_urls,
    };
  }

  if (AD_HINT.test(haystack)) {
    return {
      classification: "ad_or_drift",
      adoptable: false,
      target_decision: "close_unadopted",
      reason: "ad_promo_or_download_signal",
      same_origin,
    };
  }

  if (PLAYER_HINT.test(haystack)) {
    return {
      classification: same_origin ? "same_origin_player" : "player_or_embed",
      adoptable: true,
      target_decision: "adopt_same_content_player",
      reason: same_origin ? "same_origin_player_signal" : "cross_origin_player_signal",
      same_origin,
      extracted_player_urls,
    };
  }

  return {
    classification: same_origin ? "same_origin_unknown" : "unknown",
    adoptable: false,
    target_decision: "close_unadopted",
    reason: same_origin ? "same_origin_without_player_signal" : "no_player_signal",
    same_origin,
    extracted_player_urls,
  };
}

export function scorePopupCandidate(candidate, openerUrl = "") {
  const url = String(candidate?.final_url || candidate?.finalUrl || candidate?.url || "").trim();
  if (isBlankPopupUrl(url)) return Number.NEGATIVE_INFINITY;
  const classification = classifyPopupCandidate(candidate, openerUrl);

  let score = Number(candidate?.index || 0);
  if (/^https?:/i.test(url)) score += 10;
  if (classification.adoptable) score += 80;
  if (classification.same_origin) score += 20;
  if (classification.classification === "ad_or_drift") score -= 200;

  return score;
}

export function selectPopupCandidate(candidates = [], openerUrl = "") {
  let selected = null;
  let selectedScore = Number.NEGATIVE_INFINITY;

  candidates.forEach((candidate, index) => {
    const classification = classifyPopupCandidate(candidate, openerUrl);
    if (!classification.adoptable) return;
    const score = scorePopupCandidate(
      { ...candidate, index: candidate?.index ?? index },
      openerUrl,
    );
    if (score >= selectedScore) {
      selected = candidate;
      selectedScore = score;
    }
  });

  return selectedScore < 0 ? null : selected;
}
