const DEFAULT_BUDGETS = {
  classification: 8 * 1024,
  landing: 32 * 1024,
  hosting: 14 * 1024,
  embedded: 14 * 1024,
};

const PRIORITY_RANK = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const ARTICLE_URL_PATTERN =
  /\/(?:read|post|posts|article|articles|news|blog|story|stories)(?:\/|$)/i;
const ARTICLE_SECTION_PATTERN =
  /(news|article|blog|story|related|popular|recommended|more news|more stories|أخبار|خبر|مقالات|اقرأ|المزيد)/i;
const STRONG_MATCH_CONTEXT_PATTERN =
  /(\bvs\.?\b|\bv\b|versus|@| x |×|\b\d{1,2}:\d{2}\b|match[-_\s]?card|fixture|event[-_\s]?card|schedule[-_\s]?row|live[-_\s]?match|team[-_\s]?[ab]|score|kickoff|against|ضد|مباراة|مباريات|موعد|الساعة|بث مباشر)/i;
const PLAYER_CONTEXT_PATTERN =
  /(player|iframe|server|source|watch button|play button|stream button|embed|video|server_hints|inline_server_list|js_expanded_row)/i;

const NOISE_PATTERN =
  /(login|sign in|signup|register|privacy|terms|cookie|contact|about|help|faq|telegram|discord|twitter|facebook|instagram)/i;

const WATCH_PATTERN =
  /(\/watch\/|\/live\/|\/stream\/|watch|live|stream|match|fixture|kickoff|vs|versus|channel|canal|game|event|evento|eventos|play|championship|league|liga|cup|copa|tournament|programacion|programaci[oó]n|en vivo|directo|rojadirecta|tv)/i;

const NAV_PATTERN =
  /(home|schedule|programacion|programaci[oó]n|api|status|channels|canales|category|categories|today|hoy|live|en vivo|leagues?|ligas?)/i;

const PAGINATION_URL_PATTERN =
  /([?&](page|paged|p|offset|start|cursor)=)|(\/page\/\d+)|(\/p\/\d+)|(-page-\d+)/i;
const SCHEDULE_ROW_PATTERN =
  /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|featured events?|matchtime|clock:/i;
const PROVIDER_CHANNEL_PATTERN =
  /\b(?:sports?|espn|fox|sky|tnt|dazn|willow|bein|eurosport|tsn|nba\s*tv|nfl\s*network|bt\s*sport|sport\s*tv)\b/i;

const CATEGORY_PATTERN =
  /(\/category\/|basketball|football|soccer|baseball|hockey|tennis|rugby|golf|nba|nhl|mlb|ufc|f1)/i;

const PLAY_PATTERN =
  /(play|watch|resume|start|stream|server|source|mirror|backup|quality|tap|option|opci[oó]n|opcao|op[cç][aã]o|servidor|servidores|canal|canales|canaux|quelle|fonte|fuente|lien|link|enlace|ver|voir|assistir|izle|شاهد|تشغيل|سيرفر|مصدر|قناة|لينك|رابط)/i;
const SERVER_PATTERN =
  /(server|source|mirror|backup|embed|stream|quality|cdn|audio|sub|caption|option|opci[oó]n|opcao|op[cç][aã]o|servidor|servidores|servidor[ea]s?|fuente|fuentes|fonte|fontes|canal|canales|canaux|cha[iî]ne|quelle|lien|liens|link|links|enlace|enlaces|player|iframe|hd|sd|fhd|uhd|lang|language|idioma|idiomas|audio|áudio|sonido|voz|subt[ií]tulo|legenda|caption|زبان|لغة|لغات|سيرفر|سيرفرات|مصدر|مصادر|جودة|قناة|قنوات|رابط|روابط|لينك|لينكات)/i;
const SERVER_LOCATOR_PATTERN =
  /(server|source|mirror|backup|embed|stream|quality|cdn|player|iframe|data-server|data-source|data-embed)/i;
const STREAM_URL_PATTERN = /(\.(m3u8|mpd|mp4|m4s|ts)(?:$|[?#])|\/(?:hls|dash|m3u8|mpd|manifest|playlist|tracks[^/]*)\/|(?:^|[?&])(format|type|protocol)=(hls|dash|m3u8|mpd)|(?:^|\/)(master|index|chunklist|playlist|manifest)(?:[.-]|$)|(?:^|\/)mono(?:[.-]|$).*?(token=|expires=))/i;
const DIRECT_PLAYER_URL_PATTERN = /(embed|player|iframe|\/e\/|\/v\/|\/video\/|\/watch\/|stream)/i;

const clean = (value, max = 160) =>
  String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

function compactScreenshotRef(value, max = 420) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\//i.test(raw)) return "inline_data_image_omitted";
  return raw.length > max ? `${raw.slice(0, max)}...` : raw;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function estimateTokensFromBytes(bytes) {
  return Math.ceil(bytes / 4);
}

function inferStatus(text, url = "") {
  const haystack = `${text} ${url}`.toLowerCase();
  if (/\blive\b/.test(haystack)) return "live";
  if (/upcoming|soon|today|tomorrow|\b\d{1,2}:\d{2}\b/.test(haystack)) return "upcoming";
  if (/replay|vod|highlights/.test(haystack)) return "replay";
  return "unknown";
}

function looksLikelyStreamUrl(url) {
  const candidate = String(url || "").trim();
  if (!/^https?:\/\//i.test(candidate)) return false;
  return STREAM_URL_PATTERN.test(candidate);
}

function looksLikelyDirectPlayerUrl(url) {
  const candidate = String(url || "").trim();
  if (!/^https?:\/\//i.test(candidate)) return false;
  if (looksLikelyStreamUrl(candidate)) return false;
  return DIRECT_PLAYER_URL_PATTERN.test(candidate);
}

function resolveUrlMaybe(url, baseUrl) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch {
    return raw;
  }
}

function looksLikePaginationUrl(url) {
  return PAGINATION_URL_PATTERN.test(String(url || ""));
}

function isArticleOrNewsUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  try {
    return ARTICLE_URL_PATTERN.test(new URL(raw, "https://example.invalid").pathname);
  } catch {
    return ARTICLE_URL_PATTERN.test(raw);
  }
}

function hasStrongMatchCardEvidence(entry) {
  const source = String(entry.source || "").toLowerCase();
  if (source === "nav") return false;
  const structuralHaystack = [
    entry.nearby_text,
    entry.row_text,
    entry.section_title,
    entry.classes,
    entry.selector,
    entry.xpath,
  ].map((value) => String(value || "")).join(" ");
  const titleHaystack = String(entry.text || "");
  if (PLAYER_CONTEXT_PATTERN.test(`${structuralHaystack} ${titleHaystack}`)) return true;
  if (ARTICLE_SECTION_PATTERN.test(`${entry.section_title || ""} ${entry.classes || ""} ${entry.selector || ""}`)) {
    return false;
  }
  if (
    STRONG_MATCH_CONTEXT_PATTERN.test(structuralHaystack) ||
    (
      STRONG_MATCH_CONTEXT_PATTERN.test(titleHaystack) &&
      /(match|fixture|event|schedule|live|card|row|team|club|channel|player|server)/i.test(structuralHaystack)
    )
  ) {
    return true;
  }
  return false;
}

function isArticleOnlyCandidate(entry) {
  if (!isArticleOrNewsUrl(entry.url)) return false;
  return !hasStrongMatchCardEvidence(entry);
}

function pageNumberFromUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    for (const key of ["page", "paged", "p", "offset", "start"]) {
      const value = parsed.searchParams.get(key);
      if (value && /^\d+$/.test(value)) return Number(value);
    }
    const pathMatch =
      parsed.pathname.match(/\/(?:page|p)\/(\d+)(?:\/|$)/i) ||
      parsed.pathname.match(/-page-(\d+)(?:\/|$)/i);
    return pathMatch ? Number(pathMatch[1]) : null;
  } catch {
    const match =
      raw.match(/[?&](?:page|paged|p|offset|start)=(\d+)/i) ||
      raw.match(/\/(?:page|p)\/(\d+)(?:\/|$)/i) ||
      raw.match(/-page-(\d+)(?:\/|$)/i);
    return match ? Number(match[1]) : null;
  }
}

function pageNumberFromText(text) {
  const match = String(text || "").trim().match(/^\D*(\d{1,5})\D*$/);
  return match ? Number(match[1]) : null;
}

function eventWatchBase(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^(\/watch\/[^/?#]+)/i);
    if (!match) return null;
    return `${parsed.origin}${match[1]}`;
  } catch {
    return null;
  }
}

function sameEventServerRoute(candidateUrl, currentUrl) {
  const base = eventWatchBase(currentUrl);
  if (!base) return null;
  const resolved = resolveUrlMaybe(candidateUrl, currentUrl);
  if (!resolved || !resolved.startsWith(`${base}/`)) return null;
  try {
    const basePath = new URL(base).pathname.replace(/\/+$/, "");
    const candidate = new URL(resolved);
    const current = new URL(currentUrl);
    const suffix = candidate.pathname.slice(basePath.length).replace(/^\/+|\/+$/g, "");
    if (!suffix) return null;
    const segments = suffix.split("/").filter(Boolean);
    if (!segments.length) return null;
    const provider = segments[0] || "";
    const sourceIndex = /^\d+$/.test(segments[1] || "") ? Number(segments[1]) : null;
    return {
      base_url: base,
      provider,
      source_index: sourceIndex,
      route_pattern:
        provider && sourceIndex !== null
          ? `${base}/{provider}/{n}`
          : `${base}/${segments.map((segment) => (/^\d+$/.test(segment) ? "{n}" : segment)).join("/")}`,
      current_marker:
        candidate.origin === current.origin &&
        candidate.pathname.replace(/\/+$/, "") === current.pathname.replace(/\/+$/, ""),
    };
  } catch {
    return null;
  }
}

function sourceCountFromText(text) {
  const raw = String(text || "");
  const match =
    raw.match(/(\d+)\s*(?:of\s*\d+\s*)?(?:sources?|streams?|links?|options?)/i) ||
    raw.match(/(?:sources?|streams?|links?|options?)\s*[:\-]?\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function buildPlayerHandoffCandidates(data, { limit = 28 } = {}) {
  const rows = [];
  const add = (entry) => {
    const url = String(entry.url || entry.src || "").trim();
    if (!/^https?:\/\//i.test(url)) return;
    rows.push({
      type: entry.type || "unknown",
      url,
      frame_path: entry.frame_path || "root",
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      label: clean(entry.label || entry.text || "", 100),
      likely_stream: looksLikelyStreamUrl(url),
      likely_direct_embed: looksLikelyDirectPlayerUrl(url),
      ready_state: entry.ready_state ?? null,
      paused: entry.paused ?? null,
    });
  };

  for (const frame of data.iframes || []) {
    add({
      type: "iframe_src",
      url: frame.src || "",
      selector: frame.selector || "",
      xpath: frame.xpath || "",
      label: frame.category || "",
    });
  }
  for (const video of data.videos || []) {
    add({
      type: "video_src",
      url: video.src || "",
      selector: video.selector || "",
      xpath: video.xpath || "",
      ready_state: Number(video.readyState ?? video.ready_state ?? 0),
      paused: Boolean(video.paused),
    });
    for (const source of video.sources || []) {
      add({
        type: "video_source",
        url: source,
        selector: video.selector || "",
        xpath: video.xpath || "",
      });
    }
  }
  for (const frame of data.frame_tree || []) {
    if (frame.is_main_frame) continue;
    if (frame.purpose_hint === "player" || frame.video_count > 0 || frame.has_player_library) {
      add({
        type: "frame_url",
        url: frame.url || "",
        frame_path: frame.frame_path || "root",
        label: frame.purpose_hint || "",
      });
    }
    for (const video of frame.sample_videos || []) {
      add({
        type: "frame_video_src",
        url: video.src || "",
        frame_path: frame.frame_path || "root",
        selector: video.selector || "",
        xpath: video.xpath || "",
        ready_state: Number(video.readyState ?? 0),
        paused: Boolean(video.paused),
      });
      for (const source of video.sources || []) {
        add({
          type: "frame_video_source",
          url: source,
          frame_path: frame.frame_path || "root",
          selector: video.selector || "",
          xpath: video.xpath || "",
        });
      }
    }
  }

  return dedupeBy(
    rows
      .filter((entry) => entry.likely_stream || entry.likely_direct_embed || entry.type.includes("iframe") || entry.type.includes("frame"))
      .sort((a, b) => Number(b.likely_stream || b.likely_direct_embed) - Number(a.likely_stream || a.likely_direct_embed)),
    (entry) => `${entry.type}|${entry.url}|${entry.frame_path}`,
  ).slice(0, limit);
}

function urlPattern(urls) {
  const normalized = (urls || []).filter(Boolean).map((url) => String(url).trim());
  if (!normalized.length) return "";
  if (normalized.every((url) => /\/watch\/[^/]+$/i.test(url))) return "/watch/{slug}";
  if (normalized.every((url) => /\/category\/[^/]+$/i.test(url))) return "/category/{slug}";
  if (normalized.every((url) => /\/schedule\b/i.test(url))) return "/schedule";
  return "";
}

function generalizedUrlPattern(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname
      .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, "/{token}")
      .replace(/[0-9a-fA-F]{8,}/g, "{id}")
      .replace(/\d+/g, "{n}");
    const query = [];
    for (const [key, value] of parsed.searchParams.entries()) {
      let normalized = value;
      if (/^\d+$/.test(normalized)) normalized = "{n}";
      else if (/^[0-9a-fA-F]{8,}$/.test(normalized)) normalized = "{id}";
      else if (normalized.length >= 16 && /^[A-Za-z0-9_-]+$/.test(normalized)) normalized = "{token}";
      query.push([key, normalized]);
    }
    query.sort(([a], [b]) => a.localeCompare(b));
    const queryText = query
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&")
      .replace(/%7B/g, "{")
      .replace(/%7D/g, "}");
    return `${parsed.origin}${path}${queryText ? `?${queryText}` : ""}`;
  } catch {
    return raw
      .replace(/\d+/g, "{n}")
      .replace(/[0-9a-fA-F]{8,}/g, "{id}")
      .replace(/[A-Za-z0-9_-]{24,}/g, "{token}");
  }
}

function representativeLimit(priority = "low") {
  if (priority === "critical") return 10;
  if (priority === "high") return 8;
  if (priority === "medium") return 5;
  return 1;
}

function pickRepresentatives(items, priority = "low", keyFn = (item) => JSON.stringify(item)) {
  const limit = representativeLimit(priority);
  const picked = [];
  const seen = new Set();
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return picked;
}

function buildRawCounts(data) {
  return {
    content_links: (data.contentLinks || []).length,
    nav_links: (data.navLinks || []).length,
    buttons: (data.buttons || []).length,
    elements: (data.elements || []).length,
    iframes: (data.iframes || []).length,
    videos: (data.videos || []).length,
    popups: (data.popups || []).length,
    frames: (data.frame_tree || []).length,
    reveal_controls: (data.reveal_controls || []).length,
    collapsed_sections: (data.collapsed_sections || []).length,
  };
}

function buildOutputCounts(payload) {
  return {
    link_groups: (payload.link_groups || payload.match_groups || payload.navigation_groups || payload.grouped_sections?.groups || []).length,
    action_groups: (payload.action_groups || payload.control_groups || payload.playback_groups || payload.player_groups || []).length,
    top_watch_candidates: (payload.top_candidates?.watch || payload.top_match_candidates || []).length,
    server_frontier: (payload.server_frontier || []).length,
    activation_candidates: (payload.activation_candidates || []).length,
    blocker_candidates: (payload.blocker_candidates || []).length,
    candidate_ledger: (payload.candidate_ledger || []).length,
    top_navigation_candidates: (payload.top_candidates?.navigation || []).length,
    top_action_candidates: (payload.top_candidates?.actions || payload.top_server_controls || payload.top_source_controls || payload.top_playback_targets || payload.top_player_targets || []).length,
  };
}

function attachCompressionTelemetry(payload, rawCounts, budgetTarget, originalBytes, steps) {
  const compressedBytes = jsonBytes(payload);
  payload.stats = {
    ...(payload.stats || {}),
    raw_counts: rawCounts,
    output_counts: buildOutputCounts(payload),
    compressed_bytes: compressedBytes,
    estimated_tokens: estimateTokensFromBytes(compressedBytes),
    compression_ratio: originalBytes > 0 ? Number((compressedBytes / originalBytes).toFixed(3)) : 1,
    budget_target: budgetTarget,
    budget_fit: compressedBytes <= budgetTarget,
    compression_steps: dedupeBy(steps, (step) => step),
  };
  return payload;
}

function reduceSamples(groups, field, priorities = ["low", "medium", "high", "critical"], min = 1) {
  for (const priority of priorities) {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      if ((group.priority || "low") !== priority) continue;
      if (Array.isArray(group[field]) && group[field].length > min) {
        group[field].pop();
        return true;
      }
    }
  }
  return false;
}

function reduceArray(items, min = 1) {
  if (!Array.isArray(items) || items.length <= min) return false;
  items.pop();
  return true;
}

function dropLowPriorityGroups(groups, min = 1) {
  if (!Array.isArray(groups) || groups.length <= min) return false;
  let candidateIndex = -1;
  let candidateRank = Number.POSITIVE_INFINITY;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const rank = PRIORITY_RANK[groups[index].priority || "low"] || PRIORITY_RANK.low;
    if (rank < candidateRank) {
      candidateRank = rank;
      candidateIndex = index;
    }
  }
  if (candidateIndex < 0) return false;
  groups.splice(candidateIndex, 1);
  return true;
}

function fitPayloadToBudget(payload, { budgetTarget, reducers, rawCounts }) {
  const working = structuredClone(payload);
  const originalBytes = jsonBytes(working);
  const steps = [];

  if (originalBytes > budgetTarget) {
    for (const reducer of reducers) {
      while (jsonBytes(working) > budgetTarget && reducer.apply(working)) {
        steps.push(reducer.name);
      }
      if (jsonBytes(working) <= budgetTarget) break;
    }
  }

  return attachCompressionTelemetry(working, rawCounts, budgetTarget, originalBytes, steps);
}

function collectLinks(data) {
  const rootContent = (data.contentLinks || []).map((entry) => ({
    text: clean(entry.text, 140),
    nearby_text: clean(entry.nearby_text || entry.row_text, 220),
    row_text: clean(entry.row_text, 260),
    section_title: clean(entry.section_title, 120),
    url: entry.href || "",
    classes: clean(entry.classes, 120),
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    frame_path: "root",
    source: "content",
  }));
  const nav = (data.navLinks || []).map((entry) => ({
    text: clean(entry.text, 120),
    nearby_text: clean(entry.nearby_text || entry.row_text, 220),
    row_text: clean(entry.row_text, 260),
    section_title: clean(entry.section_title, 120),
    url: entry.href || "",
    classes: clean(entry.classes, 120),
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    frame_path: "root",
    source: "nav",
  }));
  const frameLinks = (data.frame_tree || []).flatMap((frame) =>
    (frame.sample_links || []).map((entry) => ({
      text: clean(entry.text, 120),
      nearby_text: clean(entry.nearby_text || entry.row_text, 220),
      row_text: clean(entry.row_text, 260),
      section_title: clean(entry.section_title, 120),
      url: entry.href || "",
      classes: clean(entry.classes, 120),
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      x: Math.round(entry.x || 0),
      y: Math.round(entry.y || 0),
      frame_path: frame.frame_path || "root",
      source: "frame",
    })),
  );
  const collapsedLinks = [
    ...(data.collapsed_sections || []).flatMap((section) =>
      [...(section.hidden_link_samples || []), ...(section.sample_links || [])].map((entry) => ({
        text: clean(entry.text, 120),
        nearby_text: clean(entry.nearby_text || entry.row_text, 220),
        row_text: clean(entry.row_text, 260),
        section_title: clean(entry.section_title, 120),
        url: entry.href || "",
        classes: clean(entry.classes, 120),
        selector: entry.selector || "",
        xpath: entry.xpath || "",
        x: Math.round(entry.x || 0),
        y: Math.round(entry.y || 0),
        frame_path: entry.frame_path || "root",
        source: "collapsed",
        hidden: !entry.visible,
      })),
    ),
    ...(data.reveal_controls || []).flatMap((control) =>
      (control.sample_links || []).map((entry) => ({
        text: clean(entry.text, 120),
        nearby_text: clean(entry.nearby_text || entry.row_text, 220),
        row_text: clean(entry.row_text, 260),
        section_title: clean(entry.section_title, 120),
        url: entry.href || "",
        classes: clean(entry.classes, 120),
        selector: entry.selector || "",
        xpath: entry.xpath || "",
        x: Math.round(entry.x || 0),
        y: Math.round(entry.y || 0),
        frame_path: entry.frame_path || "root",
        source: "reveal",
        hidden: !entry.visible,
      })),
    ),
  ];

  return dedupeBy(
    [...rootContent, ...nav, ...frameLinks, ...collapsedLinks]
      .filter((entry) => entry.url && !entry.url.startsWith("javascript:"))
      .filter((entry) => !NOISE_PATTERN.test(`${entry.text} ${entry.url}`))
      .map((entry) => ({
        ...entry,
        status: inferStatus(`${entry.text} ${entry.nearby_text} ${entry.row_text}`, entry.url),
      })),
    (entry) => `${entry.frame_path}|${entry.url}|${entry.text}|${entry.source}`,
  );
}

function collectActions(data, { linksOnlyIfPlayable = false } = {}) {
  const raw = [
    ...(data.buttons || []),
    ...(data.reveal_controls || []),
    ...(data.elements || []).filter((entry) =>
      ["button", "tab", "select", "checkbox", "radio", "input", "link"].includes(entry.kind || entry.type || ""),
    ),
  ];

  return dedupeBy(
    raw
      .map((entry) => ({
        kind: entry.kind || entry.type || "unknown",
        text: clean(entry.text, 120),
        selector: entry.selector || "",
        xpath: entry.xpath || "",
        x: Math.round(entry.x || 0),
        y: Math.round(entry.y || 0),
        frame_path: entry.frame_path || "root",
        href: entry.href || "",
        data: entry.data || {},
        state: entry.state || "",
        active: Boolean(entry.active),
        checked: Boolean(entry.checked),
        hidden_link_count: Number(entry.hidden_link_count || 0),
        visible_link_count: Number(entry.visible_link_count || 0),
        source: entry.source || "root",
      }))
      .filter((entry) => entry.text || entry.selector || entry.xpath)
      .filter((entry) => !linksOnlyIfPlayable || PLAY_PATTERN.test(`${entry.text} ${entry.selector} ${entry.xpath}`) || entry.kind !== "link"),
    (entry) => `${entry.frame_path}|${entry.kind}|${entry.selector}|${entry.xpath}|${entry.text}`,
  );
}

function isServerSourceAction(entry) {
  const textHaystack = [
    entry.text,
    entry.data?.server,
    entry.data?.source,
    entry.data?.embed,
  ].filter(Boolean).join(" ");
  const locatorHaystack = [
    entry.selector,
    entry.xpath,
    entry.href,
  ].filter(Boolean).join(" ");
  return SERVER_PATTERN.test(textHaystack) || SERVER_LOCATOR_PATTERN.test(locatorHaystack);
}

function collectFrameActions(data) {
  const rows = [];
  for (const frame of data.frame_tree || []) {
    const framePath = frame.frame_path || "root";
    for (const entry of frame.sample_buttons || []) {
      rows.push({
        kind: entry.kind || "button",
        text: clean(entry.text, 120),
        selector: entry.selector || "",
        xpath: entry.xpath || "",
        x: Math.round(entry.x || 0),
        y: Math.round(entry.y || 0),
        frame_path: framePath,
        href: entry.href || entry.url || "",
        data: entry.data || {},
        state: entry.state || "",
        active: Boolean(entry.active),
        checked: Boolean(entry.checked),
        hidden_link_count: Number(entry.hidden_link_count || 0),
        visible_link_count: Number(entry.visible_link_count || 0),
        source: "frame_button",
      });
    }
    for (const entry of frame.sample_links || []) {
      rows.push({
        kind: "link",
        text: clean(entry.text, 120),
        selector: entry.selector || "",
        xpath: entry.xpath || "",
        x: Math.round(entry.x || 0),
        y: Math.round(entry.y || 0),
        frame_path: framePath,
        href: entry.href || entry.url || "",
        data: entry.data || {},
        state: entry.state || "",
        active: Boolean(entry.active),
        checked: Boolean(entry.checked),
        hidden_link_count: 0,
        visible_link_count: 0,
        source: "frame_link",
      });
    }
  }

  return dedupeBy(
    rows.filter((entry) => entry.text || entry.selector || entry.xpath || entry.href),
    (entry) => `${entry.frame_path}|${entry.kind}|${entry.selector}|${entry.xpath}|${entry.href}|${entry.text}`,
  );
}

function collectFrameVideoTargets(data) {
  const rows = [];
  for (const frame of data.frame_tree || []) {
    const framePath = frame.frame_path || "root";
    for (const video of frame.sample_videos || []) {
      rows.push({
        kind: "video",
        text: clean(video.src || "video", 120),
        selector: video.selector || "",
        xpath: video.xpath || "",
        x: Math.round(video.x || 0),
        y: Math.round(video.y || 0),
        frame_path: framePath,
        href: video.src || "",
        ready_state: Number(video.readyState ?? video.ready_state ?? 0),
        paused: Boolean(video.paused),
      });
    }
  }
  return rows;
}

function buildPlayerEvidence(data, { videoSampleLimit = 6, iframeSampleLimit = 6, frameSampleLimit = 6 } = {}) {
  const topFrames = (data.frame_tree || [])
    .slice()
    .sort((a, b) => {
      const aScore =
        (a.video_count || 0) * 5 + (a.has_server_controls ? 4 : 0) + (a.has_player_library ? 6 : 0);
      const bScore =
        (b.video_count || 0) * 5 + (b.has_server_controls ? 4 : 0) + (b.has_player_library ? 6 : 0);
      return bScore - aScore;
    })
    .slice(0, frameSampleLimit)
    .map((frame) => ({
      frame_path: frame.frame_path,
      depth: frame.depth,
      purpose_hint: frame.purpose_hint,
      url: frame.url,
      video_count: frame.video_count,
      total_links: frame.total_links,
      total_buttons: frame.total_buttons,
      has_server_controls: frame.has_server_controls,
      has_player_library: frame.has_player_library,
    }));

  return {
    has_video: Boolean(data.hosting_signals?.has_video),
    video_count: (data.videos || []).length,
    has_player_iframe: Boolean(data.hosting_signals?.has_player_iframe),
    player_iframe_src: data.hosting_signals?.player_iframe_src || null,
    visible_content_iframes: Number(data.hosting_signals?.visible_content_iframes || 0),
    player_libraries: Boolean(data.hosting_signals?.player_libraries),
    server_tabs: Boolean(data.hosting_signals?.server_tabs),
    video_samples: (data.videos || []).slice(0, Math.min(videoSampleLimit, 3)).map((video) => ({
      selector: video.selector || "",
      xpath: video.xpath || "",
      src: video.src || "",
      paused: Boolean(video.paused),
      ready_state: Number(video.readyState || 0),
      network_state: Number(video.networkState || 0),
    })),
    iframe_samples: (data.iframes || []).slice(0, Math.min(iframeSampleLimit, 3)).map((frame) => ({
      src: frame.src || "",
      category: frame.category || "unknown",
      selector: frame.selector || "",
      xpath: frame.xpath || "",
    })),
    top_frames: topFrames,
  };
}

function buildFrameOverview(data, playerEvidence) {
  return {
    total_frames: (data.frame_tree || []).length,
    max_depth: (data.frame_tree || []).reduce(
      (max, frame) => Math.max(max, frame.depth || 0),
      0,
    ),
    frames_with_video: (data.frame_tree || []).filter((frame) => frame.video_count > 0).length,
    frames_with_server_controls: (data.frame_tree || []).filter((frame) => frame.has_server_controls).length,
    sample_frames: playerEvidence.top_frames,
  };
}

function classifyLinkGroup(entry) {
  const url = String(entry.url || "").toLowerCase();
  const text = String(entry.text || "").toLowerCase();
  const source = String(entry.source || "").toLowerCase();
  if (/status/.test(url) || /\bstatus\b/.test(text)) return "status_links";
  if (/\/category\//.test(url) || CATEGORY_PATTERN.test(text)) return "sports_categories";
  if (/\/watch\//.test(url) && /\blive\b/.test(text)) return "live_watch_cards";
  if (/\/watch\//.test(url) && /\b(channel|tv)\b/.test(text)) return "channel_watch_links";
  if (/\/watch\//.test(url)) return "watch_links";
  if (/\/schedule/.test(url) || /\bschedule\b/.test(text)) return "schedule_links";
  if (source === "nav" || NAV_PATTERN.test(text)) return "header_nav";
  if (/mirror|backup/.test(text)) return "mirror_links";
  return "misc_links";
}

function landingLinkGroup(entry) {
  const url = String(entry.url || "").toLowerCase();
  const text = String(entry.text || "").toLowerCase();
  const source = String(entry.source || "").toLowerCase();
  const status = String(entry.status || "").toLowerCase();
  if (looksLikePaginationUrl(url)) return "pagination_links";
  if (isArticleOnlyCandidate(entry)) return "news_article_links";
  if (/status/.test(url) || /\bstatus\b/.test(text)) return "status_links";
  if (source === "nav") return "header_nav";
  if (/\/category\//.test(url) || CATEGORY_PATTERN.test(text)) return "sports_categories";
  if (WATCH_PATTERN.test(`${text} ${url}`) && status === "live") return "live_watch_cards";
  if (WATCH_PATTERN.test(`${text} ${url}`) && /\b(channel|tv)\b/.test(text)) return "live_channels";
  if (WATCH_PATTERN.test(`${text} ${url}`)) return "watch_links";
  if (NAV_PATTERN.test(text)) return "header_nav";
  if (/\/schedule/.test(url) || /\bschedule\b/.test(text)) return "schedule_links";
  if (/mirror|backup/.test(text)) return "mirror_links";
  return "misc_links";
}

function priorityForLabel(label) {
  if (["live_watch_cards", "watch_links", "server_switches", "source_switches", "play_controls", "reveal_controls"].includes(label)) return "high";
  if (["sports_categories", "channel_watch_links", "live_channels", "filter_tabs", "schedule_links", "pagination_links", "quality_switches"].includes(label)) return "medium";
  return "low";
}

function buildLinkGroups(links, labelFn) {
  const grouped = new Map();
  for (const link of links) {
    const label = labelFn(link);
    const existing = grouped.get(label) || [];
    existing.push(link);
    grouped.set(label, existing);
  }
  return [...grouped.entries()]
    .map(([label, entries], index) => {
      const priority = priorityForLabel(label);
      const urls = dedupeBy(entries.map((entry) => entry.url).filter(Boolean), (url) => url);
      const frames = dedupeBy(
        entries.map((entry) => entry.frame_path || "root").filter(Boolean),
        (framePath) => framePath,
      );
      return {
        group_id: `g${index + 1}`,
        label,
        priority,
        pattern: urlPattern(urls) || label.replace(/_/g, " "),
        count: entries.length,
        frames,
        sample_items: pickRepresentatives(
          entries.map((entry) => ({
            text: entry.text,
            url: entry.url,
            status: entry.status,
            frame_path: entry.frame_path || "root",
          })),
          priority,
          (entry) => `${entry.status}|${entry.text}|${entry.url}|${entry.frame_path}`,
        ),
        url_samples: pickRepresentatives(
          urls,
          priority,
          (url) => url,
        ),
      };
    })
    .sort((a, b) => {
      const rankDiff =
        (PRIORITY_RANK[b.priority || "low"] || PRIORITY_RANK.low) -
        (PRIORITY_RANK[a.priority || "low"] || PRIORITY_RANK.low);
      return rankDiff || b.count - a.count;
    });
}

function compactActionCandidate(entry) {
  return {
    kind: entry.kind,
    text: entry.text,
    frame_path: entry.frame_path || "root",
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    href: entry.href || "",
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    state: entry.state || "",
    active: Boolean(entry.active),
    data: entry.data || {},
    hidden_link_count: Number(entry.hidden_link_count || 0),
  };
}

function compactLinkCandidate(entry) {
  return {
    text: entry.text,
    title: entry.text || entry.nearby_text || "",
    nearby_text: entry.nearby_text || "",
    row_text: entry.row_text || "",
    source_section: entry.section_title || "",
    url: entry.url,
    status: entry.status,
    frame_path: entry.frame_path || "root",
    source: entry.source || "",
    hidden: Boolean(entry.hidden),
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
  };
}

function scheduledTimeFromText(...values) {
  const haystack = values.map((value) => String(value || "")).join(" ");
  const match = haystack.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  return match ? match[0] : "";
}

function compactLedgerCandidate(entry) {
  const title = clean(entry.text || entry.row_text || entry.nearby_text || "", 180);
  const nearby = clean(entry.row_text || entry.nearby_text || entry.text || "", 260);
  const pattern = generalizedUrlPattern(entry.url);
  return {
    url: entry.url,
    title,
    nearby_text: nearby,
    row_text: clean(entry.row_text, 260),
    source_section: entry.section_title || "",
    status: entry.status || inferStatus(`${entry.text} ${entry.nearby_text} ${entry.row_text}`, entry.url),
    scheduled_time: scheduledTimeFromText(entry.text, entry.nearby_text, entry.row_text),
    source: entry.source || "",
    frame_path: entry.frame_path || "root",
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    hidden: Boolean(entry.hidden),
    url_pattern: pattern,
  };
}

function candidatePriority(entry) {
  const sourceRank = { content: 6, collapsed: 5, reveal: 5, frame: 4, nav: 2 };
  let score = sourceRank[entry.source] || 1;
  const haystack = `${entry.text || entry.title || ""} ${entry.nearby_text} ${entry.row_text} ${entry.classes || ""} ${entry.url}`.toLowerCase();
  if (isArticleOnlyCandidate(entry)) score -= 12;
  if (ARTICLE_SECTION_PATTERN.test(`${entry.section_title || ""} ${entry.classes || ""}`)) score -= 4;
  if (/\blive\b|en vivo|directo|watch|play|stream|eventos|canal|channel|tv/.test(haystack)) score += 4;
  if (WATCH_PATTERN.test(haystack)) score += 3;
  if (SCHEDULE_ROW_PATTERN.test(haystack)) score += 3;
  if (PROVIDER_CHANNEL_PATTERN.test(haystack)) score += 2;
  if (entry.hidden) score -= 1;
  return score;
}

function looksLikeLandingCandidate(entry) {
  if (!entry.url || looksLikePaginationUrl(entry.url)) return false;
  if (isArticleOnlyCandidate(entry)) return false;
  const haystack = `${entry.text || ""} ${entry.nearby_text || ""} ${entry.row_text || ""} ${entry.classes || ""} ${entry.url || ""}`;
  if (WATCH_PATTERN.test(haystack) || PROVIDER_CHANNEL_PATTERN.test(haystack)) return true;
  return (
    entry.source === "content" &&
    SCHEDULE_ROW_PATTERN.test(haystack) &&
    !NOISE_PATTERN.test(`${entry.text || ""} ${entry.url || ""}`)
  );
}

function landingCandidateFrontier(links) {
  const candidates = (links || []).filter((entry) => looksLikeLandingCandidate(entry));
  const bodyCandidates = candidates.filter((entry) => entry.source !== "nav");
  return bodyCandidates.length ? bodyCandidates : candidates;
}

function buildCandidateLedger(links, { limit = 100 } = {}) {
  const rows = dedupeBy(
    landingCandidateFrontier(links)
      .map(compactLedgerCandidate)
      .sort((a, b) => candidatePriority(b) - candidatePriority(a)),
    (entry) => entry.url,
  );
  return rows.slice(0, limit);
}

function buildCandidateGroups(candidateLedger, { groupLimit = 24, sampleLimit = 24 } = {}) {
  const grouped = new Map();
  for (const candidate of candidateLedger || []) {
    const key = candidate.url_pattern || generalizedUrlPattern(candidate.url);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(candidate);
  }
  return Array.from(grouped.entries())
    .map(([pattern, entries], index) => ({
      group_id: `cg${index + 1}`,
      label: "hosting_candidate_pattern",
      priority: "high",
      pattern,
      count: entries.length,
      representative_url: entries[0]?.url || "",
      source_sections: dedupeBy(
        entries.map((entry) => entry.source_section).filter(Boolean),
        (item) => item,
      ).slice(0, 6),
      sample_items: entries.slice(0, sampleLimit).map((entry) => ({
        url: entry.url,
        title: entry.title,
        status: entry.status,
        scheduled_time: entry.scheduled_time,
        selector: entry.selector,
        xpath: entry.xpath,
        source: entry.source,
      })),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, groupLimit);
}

function pickTopLinkCandidates(links, priority = "medium") {
  return pickRepresentatives(
    links.map(compactLinkCandidate),
    priority,
    (entry) => `${entry.status}|${entry.text}|${entry.url}|${entry.frame_path}`,
  );
}

function pickTopActionCandidates(actions, priority = "high") {
  return pickRepresentatives(
    actions.map(compactActionCandidate),
    priority,
    (entry) => `${entry.text}|${entry.selector}|${entry.xpath}|${entry.frame_path}`,
  );
}

function buildActionGroups(actions, mode = "classification") {
  const grouped = new Map();
  for (const action of actions) {
    const label = actionGroupLabel(action, mode);
    const existing = grouped.get(label) || [];
    existing.push(action);
    grouped.set(label, existing);
  }
  return [...grouped.entries()]
    .map(([label, entries], index) => {
      const priority = priorityForLabel(label);
      return {
        group_id: `a${index + 1}`,
        label,
        priority,
        count: entries.length,
        sample_items: pickRepresentatives(
          entries.map((entry) => ({
            kind: entry.kind,
            text: entry.text,
            frame_path: entry.frame_path || "root",
            selector: entry.selector || "",
            xpath: entry.xpath || "",
            state: entry.state || "",
            hidden_link_count: Number(entry.hidden_link_count || 0),
          })),
          priority,
          (entry) => `${entry.kind}|${entry.text}|${entry.selector}|${entry.xpath}|${entry.frame_path}|${entry.state}`,
        ),
      };
    })
    .sort((a, b) => {
      const rankDiff =
        (PRIORITY_RANK[b.priority || "low"] || PRIORITY_RANK.low) -
        (PRIORITY_RANK[a.priority || "low"] || PRIORITY_RANK.low);
      return rankDiff || b.count - a.count;
    });
}

function actionGroupLabel(entry, mode) {
  const haystack =
    `${entry.text} ${entry.href} ${entry.data?.server || ""} ${entry.data?.source || ""} ${entry.data?.embed || ""}`.toLowerCase();
  if (
    entry.kind === "reveal_control" ||
    entry.data?.reveals_hidden_content ||
    entry.state === "collapsed" ||
    /aria-expanded|aria-controls|accordion|collapse|dropdown|show|view|more|load|expand|toggle|menu|channels|live tv|tv guide/.test(haystack)
  ) return "reveal_controls";
  if (
    /server|source|mirror|backup|stream|option|opci[oó]n|opcao|op[cç][aã]o|servidor|servidores|fuente|fuentes|fonte|fontes|canal|canales|canaux|quelle|lien|liens|link|links|enlace|enlaces|سيرفر|سيرفرات|مصدر|مصادر|قناة|قنوات|رابط|روابط|لينك|لينكات/.test(haystack)
  ) return mode === "embedded" ? "source_switches" : "server_switches";
  if (/audio|sub|caption|lang|language|idioma|idiomas|áudio|sonido|voz|subt[ií]tulo|legenda|لغة|لغات/.test(haystack)) return "track_switches";
  if (/embed|iframe/.test(haystack)) return "embed_targets";
  if (/hd|sd|720|1080|quality/.test(haystack)) return "quality_switches";
  if (/play|watch|resume|start|stream|tap/.test(haystack)) return "play_controls";
  if (/filter|category|league|sport|tab/.test(haystack)) return "filter_tabs";
  if (/next|more|load/.test(haystack)) return "pagination_actions";
  return "misc_controls";
}

function buildIframeGroups(data, mode = "hosting") {
  return (data.frame_tree || [])
    .filter((frame) => !frame.is_main_frame)
    .map((frame, index) => ({
      group_id: `f${index + 1}`,
      label:
        frame.purpose_hint === "player"
          ? mode === "embedded"
            ? "player_frames"
            : "player_iframe_candidates"
          : frame.has_server_controls
            ? "server_control_frames"
            : "other_frames",
      priority: frame.purpose_hint === "player" || frame.has_server_controls ? "high" : "low",
      count: 1,
      frame_path: frame.frame_path,
      depth: frame.depth,
      url: frame.url,
      video_count: frame.video_count,
      total_buttons: frame.total_buttons,
      total_links: frame.total_links,
      has_server_controls: frame.has_server_controls,
      has_player_library: frame.has_player_library,
      sample_buttons: pickRepresentatives((frame.sample_buttons || []).map((entry) => ({
        text: clean(entry.text, 100),
        selector: entry.selector || "",
        xpath: entry.xpath || "",
        frame_path: frame.frame_path,
      })), frame.purpose_hint === "player" || frame.has_server_controls ? "high" : "low", (entry) => `${entry.text}|${entry.selector}|${entry.xpath}`),
      sample_links: pickRepresentatives((frame.sample_links || []).map((entry) => ({
        text: clean(entry.text, 100),
        url: entry.href || "",
        selector: entry.selector || "",
        xpath: entry.xpath || "",
        frame_path: frame.frame_path,
      })), frame.purpose_hint === "player" || frame.has_server_controls ? "high" : "low", (entry) => `${entry.text}|${entry.url}|${entry.selector}`),
      sample_videos: pickRepresentatives((frame.sample_videos || []).map((video) => ({
        kind: "video",
        text: clean(video.src || "video", 100),
        selector: video.selector || "",
        xpath: video.xpath || "",
        x: Math.round(video.x || 0),
        y: Math.round(video.y || 0),
        frame_path: frame.frame_path,
        ready_state: Number(video.readyState ?? video.ready_state ?? 0),
        paused: Boolean(video.paused),
      })), frame.purpose_hint === "player" || frame.video_count > 0 ? "high" : "low", (entry) => `${entry.frame_path}|${entry.selector}|${entry.xpath}|${entry.text}`),
    }))
    .sort((a, b) => {
      const rankDiff =
        (PRIORITY_RANK[b.priority || "low"] || PRIORITY_RANK.low) -
        (PRIORITY_RANK[a.priority || "low"] || PRIORITY_RANK.low);
      return rankDiff || (b.video_count || 0) - (a.video_count || 0);
    });
}

function buildPaginationSummary(data) {
  const currentPage = pageNumberFromUrl(data.url) || 1;
  const paginationLinks = dedupeBy(
    (data.pagination?.elements || [])
      .map((entry) => {
        const href = entry.href || "";
        const pageNumber = pageNumberFromUrl(href) || pageNumberFromText(entry.text);
        return {
          text: clean(entry.text, 80),
          href,
          selector: entry.selector || "",
          xpath: entry.xpath || "",
          page: pageNumber,
        };
      })
      .filter((entry) => entry.href || entry.text)
      .filter((entry) => looksLikePaginationUrl(entry.href) || entry.page !== null),
    (entry) => `${entry.href}|${entry.text}|${entry.selector}|${entry.xpath}`,
  );
  const numberedLinks = paginationLinks.filter((entry) => Number.isFinite(entry.page));
  const pageNumbers = numberedLinks.map((entry) => Number(entry.page)).filter((value) => value > 0);
  const nextLink =
    numberedLinks
      .filter((entry) => Number(entry.page) > currentPage)
      .sort((a, b) => Number(a.page) - Number(b.page))[0] ||
    paginationLinks.find((entry) => /next|»|›|more/i.test(`${entry.text} ${entry.href}`)) ||
    null;
  const firstPatternLink = paginationLinks.find((entry) => looksLikePaginationUrl(entry.href));

  return {
    detected: Boolean(data.pagination?.detected || paginationLinks.length),
    type: firstPatternLink?.href?.includes("?") ? "query" : data.pagination?.type || null,
    current_page: currentPage,
    max_visible_page: pageNumbers.length ? Math.max(...pageNumbers) : null,
    next_url: nextLink?.href || "",
    url_pattern: firstPatternLink ? generalizedUrlPattern(firstPatternLink.href) : "",
    page_urls: dedupeBy(
      paginationLinks.map((entry) => entry.href).filter(Boolean),
      (href) => href,
    ).slice(0, 24),
    sample_links: paginationLinks.slice(0, 24),
  };
}

function compactLinkSample(entry) {
  return {
    text: clean(entry.text, 100),
    url: entry.href || entry.url || "",
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    frame_path: entry.frame_path || "root",
    hidden: entry.visible === false || Boolean(entry.hidden),
  };
}

function buildRevealActions(data, { limit = 14, sampleLimit = 4 } = {}) {
  const rows = (data.reveal_controls || []).map((entry) => ({
    kind: entry.kind || "reveal_control",
    text: clean(entry.text, 100),
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    href: entry.href || "",
    frame_path: entry.frame_path || "root",
    state: entry.state || "unknown",
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    hidden_link_count: Number(entry.hidden_link_count || 0),
    visible_link_count: Number(entry.visible_link_count || 0),
    sample_links: (entry.sample_links || []).slice(0, sampleLimit).map(compactLinkSample),
  }));

  return dedupeBy(
    rows.sort((a, b) =>
      (b.hidden_link_count + b.visible_link_count) - (a.hidden_link_count + a.visible_link_count),
    ),
    (entry) => `${entry.selector}|${entry.xpath}|${entry.text}|${entry.state}`,
  ).slice(0, limit);
}

function buildEventServerRoutes(data, actions, { limit = 48 } = {}) {
  const currentUrl = data.url || "";
  const routeRows = [
    ...collectLinks(data).map((entry) => ({
      text: entry.text || entry.nearby_text || "",
      href: entry.url || "",
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      frame_path: entry.frame_path || "root",
      source: entry.source || "content",
    })),
    ...(actions || []).map((entry) => ({
      text: entry.text || "",
      href: entry.href || "",
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      frame_path: entry.frame_path || "root",
      source: "action",
    })),
  ];

  const candidates = [];
  for (const entry of routeRows) {
    const route = sameEventServerRoute(entry.href, currentUrl);
    if (!route) continue;
    candidates.push({
      label: clean(entry.text || `${route.provider} ${route.source_index || ""}`, 120),
      source_group: route.provider,
      source_index: route.source_index,
      source_url: resolveUrlMaybe(entry.href, currentUrl),
      route_pattern: route.route_pattern,
      current_marker: route.current_marker || /\bcurrent\b|active|selected/i.test(entry.text || ""),
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      frame_path: entry.frame_path || "root",
      source: entry.source || "content",
      expected_source_count: sourceCountFromText(entry.text),
    });
  }

  return dedupeBy(
    candidates.sort((a, b) => {
      if (a.current_marker !== b.current_marker) return a.current_marker ? -1 : 1;
      if (a.source_group !== b.source_group) return String(a.source_group).localeCompare(String(b.source_group));
      return Number(a.source_index || 0) - Number(b.source_index || 0);
    }),
    (entry) => entry.source_url,
  ).slice(0, limit);
}

function sourceIndexFromText(...values) {
  const haystack = values.map((value) => String(value || "")).join(" ");
  const explicit =
    haystack.match(/\b(?:stream|source|server|option|link|mirror|backup|canal|lien)\s*#?\s*(\d{1,3})\b/i) ||
    haystack.match(/\b(\d{1,3})\s*(?:of|\/)\s*\d{1,3}\b/i) ||
    haystack.match(/\b(?:s|src)[-_ ]?(\d{1,3})\b/i);
  return explicit ? Number(explicit[1]) : null;
}

function sourceGroupFromText(label, data = {}) {
  const dataGroup = clean(data.source || data.server || data.embed || "", 80);
  if (dataGroup && !/^(?:s|src)?\d+$/i.test(dataGroup)) return dataGroup;

  const firstSegment = String(label || "").split(/\s*(?:\/|\||-|–|—)\s*/)[0] || "";
  const cleaned = clean(firstSegment, 80);
  if (!cleaned) return "";
  if (/^(?:stream|source|server|option|link|mirror|backup)\s*#?\s*\d+$/i.test(cleaned)) return "";
  return cleaned;
}

function sourceQualityFromText(label) {
  return String(label || "").match(/\b(4k|uhd|fhd|1080p|720p|hd|sd)\b/i)?.[1] || "";
}

function compactServerFrontierEntry(entry) {
  const output = {
    label: entry.label || "",
    action: entry.action || "interact",
    frontier_source: entry.frontier_source || "",
    frame_path: entry.frame_path || "root",
  };
  for (const key of [
    "source_group",
    "source_url",
    "route_pattern",
    "selector",
    "xpath",
    "quality",
  ]) {
    if (entry[key]) output[key] = entry[key];
  }
  if (entry.source_index !== null && entry.source_index !== undefined) {
    output.source_index = entry.source_index;
  }
  if (entry.current_marker) output.current_marker = true;
  if (entry.expected_source_count) output.expected_source_count = entry.expected_source_count;
  if (entry.x) output.x = entry.x;
  if (entry.y) output.y = entry.y;
  if (entry.data && Object.values(entry.data).some(Boolean)) output.data = entry.data;
  return output;
}

function buildServerFrontier({
  serverControls = [],
  eventServerRoutes = [],
  currentUrl = "",
  limit = 48,
} = {}) {
  const rows = [];

  for (const route of eventServerRoutes || []) {
    rows.push({
      label: route.label || route.source_url || "server route",
      source_group: route.source_group || "",
      source_index: route.source_index ?? sourceIndexFromText(route.label, route.source_url),
      source_url: route.source_url || "",
      href: route.source_url || "",
      route_pattern: route.route_pattern || "",
      current_marker: Boolean(route.current_marker),
      selector: route.selector || "",
      xpath: route.xpath || "",
      frame_path: route.frame_path || "root",
      action: "navigate",
      frontier_source: "event_server_route",
      expected_source_count: route.expected_source_count || sourceCountFromText(route.label),
      quality: sourceQualityFromText(route.label),
    });
  }

  for (const control of serverControls || []) {
    const label = clean(control.text || control.href || "server control", 140);
    const href = control.href || "";
    const sameEventRoute = href ? sameEventServerRoute(href, currentUrl) : null;
    const sourceIndex = sameEventRoute?.source_index ?? sourceIndexFromText(label, control.data?.server, control.data?.source, href);
    const stateHaystack = `${control.state || ""} ${label} ${control.selector || ""}`;
    rows.push({
      label,
      source_group: sameEventRoute?.provider || sourceGroupFromText(label, control.data),
      source_index: sourceIndex,
      source_url: href,
      href,
      route_pattern: sameEventRoute?.route_pattern || "",
      current_marker: Boolean(control.active || control.checked || sameEventRoute?.current_marker || /\b(active|selected|current|playing|checked)\b/i.test(stateHaystack)),
      selector: control.selector || "",
      xpath: control.xpath || "",
      frame_path: control.frame_path || "root",
      x: Math.round(control.x || 0),
      y: Math.round(control.y || 0),
      action: href ? "navigate_or_click" : "interact",
      frontier_source: control.source || (control.frame_path && control.frame_path !== "root" ? "frame_control" : "root_control"),
      expected_source_count: sourceCountFromText(label),
      quality: sourceQualityFromText(label),
      data: control.data || {},
    });
  }

  return dedupeBy(
    rows
      .filter((entry) => entry.label || entry.href || entry.selector || entry.xpath)
      .sort((a, b) => {
        if (a.current_marker !== b.current_marker) return a.current_marker ? -1 : 1;
        if (a.frontier_source !== b.frontier_source) {
          const sourceRank = { event_server_route: 3, frame_button: 2, frame_link: 2, root: 1, root_control: 1 };
          return (sourceRank[b.frontier_source] || 0) - (sourceRank[a.frontier_source] || 0);
        }
        if ((a.source_group || "") !== (b.source_group || "")) {
          return String(a.source_group || "").localeCompare(String(b.source_group || ""));
        }
        return Number(a.source_index || 0) - Number(b.source_index || 0);
      }),
    (entry) => `${entry.frame_path}|${entry.href}|${entry.selector}|${entry.xpath}|${entry.label}`,
  ).slice(0, limit).map(compactServerFrontierEntry);
}

function buildCollapsedSectionSummary(data, { limit = 10, sampleLimit = 5 } = {}) {
  return dedupeBy(
    (data.collapsed_sections || []).map((section) => ({
      selector: section.selector || "",
      xpath: section.xpath || "",
      text: clean(section.text, 120),
      state: section.state || "unknown",
      link_count: Number(section.link_count || 0),
      hidden_link_count: Number(section.hidden_link_count || 0),
      button_count: Number(section.button_count || 0),
      reveal_selector: section.reveal_selector || "",
      reveal_xpath: section.reveal_xpath || "",
      sample_links: (section.sample_links || []).slice(0, sampleLimit).map(compactLinkSample),
      hidden_link_samples: (section.hidden_link_samples || []).slice(0, sampleLimit).map(compactLinkSample),
    })),
    (section) => `${section.selector}|${section.xpath}|${section.text}|${section.hidden_link_count}`,
  )
    .sort((a, b) => (b.hidden_link_count + b.link_count) - (a.hidden_link_count + a.link_count))
    .slice(0, limit);
}

function buildPopupSummary(data) {
  return (data.popups || []).map((popup) => ({
    text: clean(popup.text, 120),
    selector: popup.selector || "",
    xpath: popup.xpath || "",
    close_selector: popup.close_selector || null,
    close_xpath: popup.close_xpath || null,
  }));
}

function activationReason(entry) {
  const haystack = `${entry.kind || ""} ${entry.text || ""} ${entry.selector || ""} ${entry.xpath || ""}`.toLowerCase();
  if (entry.kind === "video") return "visible video element";
  if (/play|watch|start|resume|unmute|go live/.test(haystack)) return "explicit play-like control";
  if (/player|poster|overlay|control|video-js|jwplayer|plyr/.test(haystack)) return "player surface or overlay";
  if (entry.href) return "player-like link target";
  return "candidate from player/media region";
}

function buildActivationCandidates(targets, { limit = 16 } = {}) {
  return pickTopActionCandidates(targets, "high")
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      activation_reason: activationReason(entry),
      requires_agent_choice: true,
    }));
}

function buildBlockerCandidates(popups, { limit = 10 } = {}) {
  return (popups || [])
    .slice(0, limit)
    .map((popup, index) => ({
      kind: "popup_or_overlay",
      text: popup.text || "",
      selector: popup.selector || "",
      xpath: popup.xpath || "",
      close_selector: popup.close_selector || "",
      close_xpath: popup.close_xpath || "",
      frame_path: "root",
      blocker_reason: "visible popup/modal/overlay candidate",
      requires_agent_choice: true,
      index,
    }));
}

function classificationHints(linkGroups, playerEvidence, data) {
  const listingGroups = linkGroups.filter((group) =>
    ["live_watch_cards", "watch_links", "sports_categories", "schedule_links", "header_nav"].includes(group.label),
  );
  const watchGroups = linkGroups.filter((group) =>
    ["live_watch_cards", "watch_links", "channel_watch_links"].includes(group.label),
  );

  let landingScore = 0;
  let hostScore = 0;
  let embedScore = 0;

  landingScore += listingGroups.length >= 2 ? 4 : 0;
  landingScore += watchGroups.reduce((sum, group) => sum + Math.min(group.count, 4), 0);
  landingScore += data.pagination?.detected ? 2 : 0;
  landingScore += (linkGroups.find((group) => group.label === "sports_categories")?.count || 0) > 0 ? 2 : 0;

  hostScore += playerEvidence.has_video ? 5 : 0;
  hostScore += playerEvidence.has_player_iframe ? 4 : 0;
  hostScore += playerEvidence.server_tabs ? 5 : 0;
  hostScore += (data.frame_tree || []).some((frame) => frame.has_server_controls) ? 3 : 0;
  hostScore += watchGroups.length <= 1 ? 1 : 0;

  embedScore += playerEvidence.has_video ? 4 : 0;
  embedScore += playerEvidence.has_player_iframe ? 5 : 0;
  embedScore += !watchGroups.length ? 3 : 0;
  embedScore += (linkGroups.find((group) => group.label === "header_nav")?.count || 0) === 0 ? 2 : 0;
  embedScore += playerEvidence.server_tabs ? -2 : 0;

  return {
    likely_page_type:
      landingScore >= hostScore && landingScore >= embedScore
        ? "landing_page"
        : hostScore >= embedScore
          ? "host_page"
          : "embed_video_page",
    scores: {
      landing_page: landingScore,
      host_page: hostScore,
      embed_video_page: embedScore,
    },
    reasons: dedupeBy(
      [
        listingGroups.length ? `${listingGroups.length} listing-oriented link groups detected` : "",
        playerEvidence.has_video ? "video elements detected" : "",
        playerEvidence.has_player_iframe ? "player iframe detected" : "",
        playerEvidence.server_tabs ? "server/source controls detected" : "",
        data.pagination?.detected ? "pagination detected" : "",
      ].filter(Boolean),
      (reason) => reason,
    ),
  };
}

function commonReducers(config) {
  return [
    {
      name: "trim-group-url-samples",
      apply(payload) {
        const collections = config.groupCollections(payload);
        for (const groups of collections) {
          if (reduceSamples(groups, "url_samples", ["low", "medium", "high", "critical"], 1)) {
            return true;
          }
        }
        return false;
      },
    },
    {
      name: "trim-group-sample-items",
      apply(payload) {
        const collections = config.groupCollections(payload);
        for (const groups of collections) {
          if (reduceSamples(groups, "sample_items", ["low", "medium", "high", "critical"], 1)) {
            return true;
          }
        }
        return false;
      },
    },
    {
      name: "trim-secondary-top-candidates",
      apply(payload) {
        for (const getter of config.secondaryCandidateCollections || []) {
          if (reduceArray(getter(payload), 1)) return true;
        }
        return false;
      },
    },
    {
      name: "trim-primary-top-candidates",
      apply(payload) {
        for (const getter of config.primaryCandidateCollections || []) {
          if (reduceArray(getter(payload), 1)) return true;
        }
        return false;
      },
    },
    {
      name: "trim-frame-samples",
      apply(payload) {
        for (const getter of config.frameCollections || []) {
          if (reduceArray(getter(payload), 1)) return true;
        }
        return false;
      },
    },
    {
      name: "trim-frame-group-detail-samples",
      apply(payload) {
        for (const getter of config.groupDetailCollections || []) {
          for (const collection of getter(payload)) {
            if (reduceArray(collection, 1)) return true;
          }
        }
        return false;
      },
    },
    {
      name: "trim-blockers-pagination",
      apply(payload) {
        for (const getter of config.miscCollections || []) {
          if (reduceArray(getter(payload), 1)) return true;
        }
        return false;
      },
    },
    {
      name: "drop-low-priority-groups",
      apply(payload) {
        const collections = config.groupCollections(payload);
        for (const groups of collections) {
          if (dropLowPriorityGroups(groups, 1)) return true;
        }
        return false;
      },
    },
  ];
}

export function summarizeClassificationInspect(data, options = {}) {
  const budgetTarget = options.budgetTargetBytes || DEFAULT_BUDGETS.classification;
  const rawCounts = buildRawCounts(data);
  const links = collectLinks(data);
  const actions = collectActions(data, { linksOnlyIfPlayable: true });
  const linkGroups = buildLinkGroups(links, classifyLinkGroup);
  const actionGroups = buildActionGroups(actions, "classification");
  const playerEvidence = buildPlayerEvidence(data);

  const payload = {
    context_type: "classification",
    page: {
      url: data.url,
      title: data.title,
      screenshot: data.screenshot_url ? "available" : "missing",
    },
    screenshot_url: compactScreenshotRef(data.screenshot_url),
    classification_hints: classificationHints(linkGroups, playerEvidence, data),
    link_groups: linkGroups,
    action_groups: actionGroups,
    top_candidates: {
      watch: pickTopLinkCandidates(
        links.filter((entry) => WATCH_PATTERN.test(`${entry.text} ${entry.url}`)),
        "high",
      ),
      navigation: pickTopLinkCandidates(
        links.filter((entry) => entry.source === "nav" || NAV_PATTERN.test(entry.text)),
        "medium",
      ),
      actions: pickTopActionCandidates(actions, "medium"),
    },
    player_evidence: playerEvidence,
    frame_overview: buildFrameOverview(data, playerEvidence),
    blockers: { popups: buildPopupSummary(data) },
    pagination: buildPaginationSummary(data),
    lazy_load_warmup: data.lazy_load_warmup,
    stats: {},
  };

  return fitPayloadToBudget(payload, {
    budgetTarget,
    rawCounts,
    reducers: commonReducers({
      groupCollections: (result) => [result.link_groups, result.action_groups],
      primaryCandidateCollections: [
        (result) => result.top_candidates.watch,
        (result) => result.top_candidates.actions,
      ],
      secondaryCandidateCollections: [
        (result) => result.top_candidates.navigation,
      ],
      frameCollections: [
        (result) => result.frame_overview.sample_frames,
        (result) => result.player_evidence.video_samples,
        (result) => result.player_evidence.iframe_samples,
      ],
      groupDetailCollections: [],
      miscCollections: [
        (result) => result.blockers.popups,
        (result) => result.pagination.sample_links,
      ],
    }),
  });
}

function splitLandingGroups(linkGroups) {
  const toGroupRef = (group) => ({
    group_id: group.group_id,
    label: group.label,
    priority: group.priority,
    pattern: group.pattern,
    count: group.count,
  });
  return {
    matchGroups: linkGroups.filter((group) =>
      ["live_watch_cards", "watch_links", "live_channels"].includes(group.label),
    ).map(toGroupRef),
    navigationGroups: linkGroups.filter((group) =>
      ["header_nav", "sports_categories", "schedule_links", "status_links", "mirror_links", "news_article_links"].includes(group.label),
    ).map(toGroupRef),
  };
}

export function summarizeLandingInspect(data, options = {}) {
  const budgetTarget = options.budgetTargetBytes || DEFAULT_BUDGETS.landing;
  const rawCounts = buildRawCounts(data);
  const links = collectLinks(data).map((entry) => ({ ...entry, status: inferStatus(entry.text, entry.url) }));
  const actions = collectActions(data);
  const linkGroups = buildLinkGroups(links, landingLinkGroup);
  const { matchGroups, navigationGroups } = splitLandingGroups(linkGroups);
  const actionGroups = buildActionGroups(actions, "landing");
  const playerEvidence = buildPlayerEvidence(data);
  const iframeGroups = buildIframeGroups(data, "landing");
  const playerHandoffCandidates = buildPlayerHandoffCandidates(data);
  const candidateLedger = buildCandidateLedger(links, { limit: 100 });
  const candidateGroups = buildCandidateGroups(candidateLedger);

  const payload = {
    context_type: "landing",
    page: {
      url: data.url,
      title: data.title,
      screenshot: data.screenshot_url ? "available" : "missing",
    },
    screenshot_url: compactScreenshotRef(data.screenshot_url),
    grouped_sections: {
      page: {
        url: data.url,
        title: data.title,
        screenshot: data.screenshot_url ? "available" : "missing",
      },
      groups: linkGroups,
    },
    match_groups: matchGroups,
    navigation_groups: navigationGroups,
    action_groups: actionGroups,
    candidate_ledger: candidateLedger,
    candidate_groups: candidateGroups,
    top_match_candidates: pickTopLinkCandidates(
      landingCandidateFrontier(links),
      "high",
    ),
    iframe_overview: {
      ...buildFrameOverview(data, playerEvidence),
      iframe_groups: iframeGroups,
    },
    player_evidence: playerEvidence,
    player_handoff_candidates: playerHandoffCandidates,
    reveal_actions: buildRevealActions(data),
    collapsed_sections: buildCollapsedSectionSummary(data),
    pagination: buildPaginationSummary(data),
    popups: buildPopupSummary(data),
    lazy_load_warmup: data.lazy_load_warmup,
    stats: {},
  };

  return fitPayloadToBudget(payload, {
    budgetTarget,
    rawCounts,
    reducers: [
      ...commonReducers({
      groupCollections: (result) => [
        result.grouped_sections.groups,
        result.match_groups,
        result.navigation_groups,
        result.action_groups,
        result.candidate_groups,
        result.iframe_overview.iframe_groups,
      ],
      primaryCandidateCollections: [
        (result) => result.top_match_candidates,
      ],
      secondaryCandidateCollections: [],
      frameCollections: [
        (result) => result.iframe_overview.sample_frames,
        (result) => result.player_evidence.video_samples,
        (result) => result.player_evidence.iframe_samples,
      ],
      groupDetailCollections: [
        (result) => (result.iframe_overview.iframe_groups || []).map((group) => group.sample_buttons || []),
        (result) => (result.iframe_overview.iframe_groups || []).map((group) => group.sample_links || []),
        (result) => (result.iframe_overview.iframe_groups || []).map((group) => group.sample_videos || []),
      ],
      miscCollections: [
        (result) => result.reveal_actions,
        (result) => result.collapsed_sections,
        (result) => result.popups,
        (result) => result.pagination.sample_links,
        (result) => result.player_handoff_candidates,
      ],
      }),
      {
        name: "trim-candidate-ledger-to-floor",
        apply(payload) {
          return reduceArray(payload.candidate_ledger, 30);
        },
      },
    ],
  });
}

export function summarizeHostingInspect(data, options = {}) {
  const budgetTarget = options.budgetTargetBytes || DEFAULT_BUDGETS.hosting;
  const rawCounts = buildRawCounts(data);
  const actions = collectActions(data);
  const frameActions = collectFrameActions(data);
  const allActions = [...actions, ...frameActions];
  const serverControls = allActions.filter((entry) => isServerSourceAction(entry));
  const playbackTargets = dedupeBy(
    [
      ...(data.videos || []).map((video) => ({
        kind: "video",
        text: clean(video.src || "video", 120),
        selector: video.selector || "",
        xpath: video.xpath || "",
        x: Math.round(video.x || 0),
        y: Math.round(video.y || 0),
        frame_path: "root",
        href: video.src || "",
      })),
      ...collectFrameVideoTargets(data),
      ...allActions.filter((entry) => PLAY_PATTERN.test(`${entry.text} ${entry.selector} ${entry.xpath}`)),
    ],
    (entry) => `${entry.frame_path}|${entry.selector}|${entry.xpath}|${entry.text}`,
  );
  const playerEvidence = buildPlayerEvidence(data);
  const playerHandoffCandidates = buildPlayerHandoffCandidates(data);
  const eventServerRoutes = buildEventServerRoutes(data, serverControls);
  const serverFrontier = buildServerFrontier({
    serverControls,
    eventServerRoutes,
    currentUrl: data.url || "",
  });

  const payload = {
    context_type: "hosting",
    page: {
      url: data.url,
      title: data.title,
      screenshot: data.screenshot_url ? "available" : "missing",
    },
    screenshot_url: compactScreenshotRef(data.screenshot_url),
    control_groups: buildActionGroups(serverControls, "hosting"),
    playback_groups: buildActionGroups(playbackTargets, "hosting"),
    iframe_groups: buildIframeGroups(data, "hosting"),
    player_evidence: playerEvidence,
    player_handoff_candidates: playerHandoffCandidates,
    event_server_routes: eventServerRoutes,
    server_frontier: serverFrontier,
    activation_candidates: buildActivationCandidates(playbackTargets),
    blocker_candidates: buildBlockerCandidates(buildPopupSummary(data)),
    top_server_controls: pickTopActionCandidates(serverControls, "high"),
    top_playback_targets: pickTopActionCandidates(playbackTargets, "high"),
    popups: buildPopupSummary(data),
    lazy_load_warmup: data.lazy_load_warmup,
    stats: {},
  };

  return fitPayloadToBudget(payload, {
    budgetTarget,
    rawCounts,
    reducers: [
      {
        name: "trim-event-routes-after-frontier",
        apply(payload) {
          if (!Array.isArray(payload.server_frontier) || payload.server_frontier.length <= 1) {
            return false;
          }
          return reduceArray(payload.event_server_routes, 4);
        },
      },
      ...commonReducers({
      groupCollections: (result) => [
        result.control_groups,
        result.playback_groups,
        result.iframe_groups,
      ],
      primaryCandidateCollections: [
        (result) => result.top_server_controls,
        (result) => result.top_playback_targets,
        (result) => result.server_frontier,
        (result) => result.activation_candidates,
        (result) => result.blocker_candidates,
      ],
      secondaryCandidateCollections: [],
      frameCollections: [
        (result) => result.player_evidence.top_frames,
        (result) => result.player_evidence.video_samples,
        (result) => result.player_evidence.iframe_samples,
      ],
      groupDetailCollections: [
        (result) => (result.iframe_groups || []).map((group) => group.sample_buttons || []),
        (result) => (result.iframe_groups || []).map((group) => group.sample_links || []),
        (result) => (result.iframe_groups || []).map((group) => group.sample_videos || []),
      ],
      miscCollections: [
        (result) => result.popups,
        (result) => result.player_handoff_candidates,
        (result) => result.event_server_routes,
      ],
      }),
    ],
  });
}

export function summarizeEmbeddedInspect(data, options = {}) {
  const budgetTarget = options.budgetTargetBytes || DEFAULT_BUDGETS.embedded;
  const rawCounts = buildRawCounts(data);
  const actions = collectActions(data);
  const sourceControls = actions.filter((entry) => isServerSourceAction(entry));
  const playerTargets = dedupeBy(
    [
      ...(data.videos || []).map((video) => ({
        kind: "video",
        text: clean(video.src || "video", 120),
        selector: video.selector || "",
        xpath: video.xpath || "",
        x: Math.round(video.x || 0),
        y: Math.round(video.y || 0),
        frame_path: "root",
        href: video.src || "",
      })),
      ...actions.filter((entry) => PLAY_PATTERN.test(`${entry.text} ${entry.selector} ${entry.xpath}`)),
    ],
    (entry) => `${entry.frame_path}|${entry.selector}|${entry.xpath}|${entry.text}`,
  );
  const playerEvidence = buildPlayerEvidence(data);
  const playerHandoffCandidates = buildPlayerHandoffCandidates(data);

  const payload = {
    context_type: "embedded",
    page: {
      url: data.url,
      title: data.title,
      screenshot: data.screenshot_url ? "available" : "missing",
    },
    screenshot_url: compactScreenshotRef(data.screenshot_url),
    control_groups: buildActionGroups(sourceControls, "embedded"),
    player_groups: buildActionGroups(playerTargets, "embedded"),
    frame_focus_groups: buildIframeGroups(data, "embedded"),
    player_evidence: playerEvidence,
    player_handoff_candidates: playerHandoffCandidates,
    top_source_controls: pickTopActionCandidates(sourceControls, "high"),
    top_player_targets: pickTopActionCandidates(playerTargets, "high"),
    activation_candidates: buildActivationCandidates(playerTargets),
    blocker_candidates: buildBlockerCandidates(buildPopupSummary(data)),
    popups: buildPopupSummary(data),
    lazy_load_warmup: data.lazy_load_warmup,
    stats: {},
  };

  return fitPayloadToBudget(payload, {
    budgetTarget,
    rawCounts,
    reducers: commonReducers({
      groupCollections: (result) => [
        result.control_groups,
        result.player_groups,
        result.frame_focus_groups,
      ],
      primaryCandidateCollections: [
        (result) => result.top_source_controls,
        (result) => result.top_player_targets,
        (result) => result.activation_candidates,
        (result) => result.blocker_candidates,
      ],
      secondaryCandidateCollections: [],
      frameCollections: [
        (result) => result.player_evidence.top_frames,
        (result) => result.player_evidence.video_samples,
        (result) => result.player_evidence.iframe_samples,
      ],
      groupDetailCollections: [
        (result) => (result.frame_focus_groups || []).map((group) => group.sample_buttons || []),
        (result) => (result.frame_focus_groups || []).map((group) => group.sample_links || []),
        (result) => (result.frame_focus_groups || []).map((group) => group.sample_videos || []),
      ],
      miscCollections: [
        (result) => result.popups,
        (result) => result.player_handoff_candidates,
      ],
    }),
  });
}

export {
  DEFAULT_BUDGETS,
  clean,
  dedupeBy,
  estimateTokensFromBytes,
  jsonBytes,
};
