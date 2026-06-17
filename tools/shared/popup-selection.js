const BLANK_URLS = new Set(["", "about:blank", "about:newtab"]);
const PLAYER_HINT = /(embed|live|media|play|player|stream|video|watch|webplayer)/i;
const AD_HINT =
  /(^|[./_-])(ad[sx]?|advert|banner|click|doubleclick|pop(ad|under|up)?|promo|redirect)([./?&=_-]|$)/i;

export function isBlankPopupUrl(url) {
  return BLANK_URLS.has(String(url || "").trim().toLowerCase());
}

export function scorePopupCandidate(candidate, openerUrl = "") {
  const url = String(candidate?.url || "").trim();
  if (isBlankPopupUrl(url)) return Number.NEGATIVE_INFINITY;

  let score = Number(candidate?.index || 0);
  if (/^https?:/i.test(url)) score += 10;
  if (PLAYER_HINT.test(url)) score += 40;
  if (AD_HINT.test(url)) score -= 200;

  try {
    const popup = new URL(url);
    const opener = new URL(openerUrl);
    if (popup.origin === opener.origin) score += 100;
  } catch {
    // Relative or non-HTTP URLs keep their signal-based score.
  }

  return score;
}

export function selectPopupCandidate(candidates = [], openerUrl = "") {
  let selected = null;
  let selectedScore = Number.NEGATIVE_INFINITY;

  candidates.forEach((candidate, index) => {
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
