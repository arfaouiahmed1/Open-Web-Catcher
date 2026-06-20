const BLANK_URLS = new Set(["", "about:blank", "about:newtab"]);
const PLAYER_HINT = /(embed|live|media|play|player|stream|video|watch|webplayer)/i;
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

export function classifyPopupCandidate(candidate, openerUrl = "") {
  const initialUrl = String(candidate?.initial_url || candidate?.initialUrl || "").trim();
  const finalUrl = String(candidate?.final_url || candidate?.finalUrl || candidate?.url || "").trim();
  const url = finalUrl || initialUrl;
  const title = String(candidate?.title || "").trim();
  const haystack = `${url} ${title}`.toLowerCase();
  const same_origin = sameOrigin(url, openerUrl || candidate?.opener_url || candidate?.openerUrl || "");

  if (isBlankPopupUrl(url)) {
    return {
      classification: "blank",
      adoptable: false,
      target_decision: "ignore_blank",
      reason: "blank_or_unresolved_popup",
      same_origin,
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
    };
  }

  return {
    classification: same_origin ? "same_origin_unknown" : "unknown",
    adoptable: false,
    target_decision: "close_unadopted",
    reason: same_origin ? "same_origin_without_player_signal" : "no_player_signal",
    same_origin,
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
