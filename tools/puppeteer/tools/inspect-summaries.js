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

const NOISE_PATTERN =
  /(login|sign in|signup|register|privacy|terms|cookie|contact|about|help|faq|telegram|discord|twitter|facebook|instagram)/i;

const WATCH_PATTERN =
  /(\/watch\/|\/live\/|\/stream\/|watch|live|stream|match|fixture|kickoff|vs|versus|channel|canal|game|event|evento|eventos|play|championship|league|liga|cup|copa|tournament|programacion|programaci[oó]n|en vivo|directo|rojadirecta|tv)/i;

const NAV_PATTERN =
  /(home|schedule|programacion|programaci[oó]n|api|status|channels|canales|category|categories|today|hoy|live|en vivo|leagues?|ligas?)/i;

const CATEGORY_PATTERN =
  /(\/category\/|basketball|football|soccer|baseball|hockey|tennis|rugby|golf|nba|nhl|mlb|ufc|f1)/i;

const PLAY_PATTERN = /(play|watch|resume|start|stream|server|source|mirror|backup|quality|tap)/i;
const SERVER_PATTERN = /(server|source|mirror|backup|embed|stream|quality|cdn|audio|sub|caption)/i;
const STREAM_URL_PATTERN = /(\.(m3u8|mpd|mp4|m4s|ts)(?:$|[?#])|\/(?:hls|dash|m3u8|mpd|manifest|playlist|tracks[^/]*)\/|(?:^|[?&])(format|type|protocol)=(hls|dash|m3u8|mpd)|(?:^|\/)(master|index|chunklist|playlist|manifest)(?:[.-]|$)|(?:^|\/)mono(?:[.-]|$).*?(token=|expires=))/i;
const DIRECT_PLAYER_URL_PATTERN = /(embed|player|iframe|\/e\/|\/v\/|\/video\/|\/watch\/|stream)/i;

const clean = (value, max = 160) =>
  String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

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
    nearby_text: clean(entry.nearby_text, 180),
    section_title: clean(entry.section_title, 120),
    url: entry.href || "",
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    frame_path: "root",
    source: "content",
  }));
  const nav = (data.navLinks || []).map((entry) => ({
    text: clean(entry.text, 120),
    nearby_text: clean(entry.nearby_text, 180),
    section_title: clean(entry.section_title, 120),
    url: entry.href || "",
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
      nearby_text: clean(entry.nearby_text, 180),
      section_title: clean(entry.section_title, 120),
      url: entry.href || "",
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
        nearby_text: clean(entry.nearby_text, 180),
        section_title: clean(entry.section_title, 120),
        url: entry.href || "",
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
        nearby_text: clean(entry.nearby_text, 180),
        section_title: clean(entry.section_title, 120),
        url: entry.href || "",
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
      .map((entry) => ({ ...entry, status: inferStatus(entry.text, entry.url) })),
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
        hidden_link_count: Number(entry.hidden_link_count || 0),
        visible_link_count: Number(entry.visible_link_count || 0),
      }))
      .filter((entry) => entry.text || entry.selector || entry.xpath)
      .filter((entry) => !linksOnlyIfPlayable || PLAY_PATTERN.test(`${entry.text} ${entry.selector} ${entry.xpath}`) || entry.kind !== "link"),
    (entry) => `${entry.frame_path}|${entry.kind}|${entry.selector}|${entry.xpath}|${entry.text}`,
  );
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
  if (["sports_categories", "channel_watch_links", "live_channels", "filter_tabs", "schedule_links", "quality_switches"].includes(label)) return "medium";
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
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    state: entry.state || "",
    hidden_link_count: Number(entry.hidden_link_count || 0),
  };
}

function compactLinkCandidate(entry) {
  return {
    text: entry.text,
    title: entry.text || entry.nearby_text || "",
    nearby_text: entry.nearby_text || "",
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
  const title = clean(entry.text || entry.nearby_text || "", 180);
  const nearby = clean(entry.nearby_text || entry.text || "", 220);
  const pattern = generalizedUrlPattern(entry.url);
  return {
    url: entry.url,
    title,
    nearby_text: nearby,
    source_section: entry.section_title || "",
    status: entry.status || inferStatus(`${entry.text} ${entry.nearby_text}`, entry.url),
    scheduled_time: scheduledTimeFromText(entry.text, entry.nearby_text),
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
  const haystack = `${entry.text || entry.title || ""} ${entry.nearby_text} ${entry.url}`.toLowerCase();
  if (/\blive\b|en vivo|directo|watch|play|stream|eventos|canal|channel|tv/.test(haystack)) score += 4;
  if (WATCH_PATTERN.test(haystack)) score += 3;
  if (entry.hidden) score -= 1;
  return score;
}

function buildCandidateLedger(links, { limit = 100 } = {}) {
  const rows = dedupeBy(
    (links || [])
      .filter((entry) => entry.url && WATCH_PATTERN.test(`${entry.text} ${entry.nearby_text} ${entry.url}`))
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
    `${entry.text} ${entry.href} ${entry.selector} ${entry.xpath} ${entry.data?.server || ""} ${entry.data?.source || ""} ${entry.data?.embed || ""}`.toLowerCase();
  if (
    entry.kind === "reveal_control" ||
    entry.data?.reveals_hidden_content ||
    entry.state === "collapsed" ||
    /aria-expanded|aria-controls|accordion|collapse|dropdown|show|view|more|load|expand|toggle|menu|channels|live tv|tv guide/.test(haystack)
  ) return "reveal_controls";
  if (/server|source|mirror|backup/.test(haystack)) return mode === "embedded" ? "source_switches" : "server_switches";
  if (/audio|sub|caption/.test(haystack)) return "track_switches";
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
    }))
    .sort((a, b) => {
      const rankDiff =
        (PRIORITY_RANK[b.priority || "low"] || PRIORITY_RANK.low) -
        (PRIORITY_RANK[a.priority || "low"] || PRIORITY_RANK.low);
      return rankDiff || (b.video_count || 0) - (a.video_count || 0);
    });
}

function buildPaginationSummary(data) {
  return {
    detected: Boolean(data.pagination?.detected),
    type: data.pagination?.type || null,
    sample_links: (data.pagination?.elements || []).map((entry) => ({
      text: clean(entry.text, 80),
      href: entry.href || "",
      selector: entry.selector || "",
      xpath: entry.xpath || "",
    })),
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
    screenshot_url: data.screenshot_url,
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
      ["header_nav", "sports_categories", "schedule_links", "status_links", "mirror_links"].includes(group.label),
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
    screenshot_url: data.screenshot_url,
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
      links.filter((entry) => WATCH_PATTERN.test(`${entry.text} ${entry.nearby_text} ${entry.url}`)),
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
  const serverControls = actions.filter((entry) =>
    SERVER_PATTERN.test(`${entry.text} ${entry.selector} ${entry.xpath} ${entry.href} ${entry.data?.server || ""} ${entry.data?.source || ""}`),
  );
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
      ...actions.filter((entry) => PLAY_PATTERN.test(`${entry.text} ${entry.selector} ${entry.xpath}`)),
    ],
    (entry) => `${entry.frame_path}|${entry.selector}|${entry.xpath}|${entry.text}`,
  );
  const playerEvidence = buildPlayerEvidence(data);
  const playerHandoffCandidates = buildPlayerHandoffCandidates(data);

  const payload = {
    context_type: "hosting",
    page: {
      url: data.url,
      title: data.title,
      screenshot: data.screenshot_url ? "available" : "missing",
    },
    screenshot_url: data.screenshot_url,
    control_groups: buildActionGroups(serverControls, "hosting"),
    playback_groups: buildActionGroups(playbackTargets, "hosting"),
    iframe_groups: buildIframeGroups(data, "hosting"),
    player_evidence: playerEvidence,
    player_handoff_candidates: playerHandoffCandidates,
    top_server_controls: pickTopActionCandidates(serverControls, "high"),
    top_playback_targets: pickTopActionCandidates(playbackTargets, "high"),
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
        result.playback_groups,
        result.iframe_groups,
      ],
      primaryCandidateCollections: [
        (result) => result.top_server_controls,
        (result) => result.top_playback_targets,
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
      ],
      miscCollections: [
        (result) => result.popups,
        (result) => result.player_handoff_candidates,
      ],
    }),
  });
}

export function summarizeEmbeddedInspect(data, options = {}) {
  const budgetTarget = options.budgetTargetBytes || DEFAULT_BUDGETS.embedded;
  const rawCounts = buildRawCounts(data);
  const actions = collectActions(data);
  const sourceControls = actions.filter((entry) =>
    SERVER_PATTERN.test(`${entry.text} ${entry.selector} ${entry.xpath} ${entry.href} ${entry.data?.server || ""} ${entry.data?.source || ""} ${entry.data?.embed || ""}`),
  );
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
    screenshot_url: data.screenshot_url,
    control_groups: buildActionGroups(sourceControls, "embedded"),
    player_groups: buildActionGroups(playerTargets, "embedded"),
    frame_focus_groups: buildIframeGroups(data, "embedded"),
    player_evidence: playerEvidence,
    player_handoff_candidates: playerHandoffCandidates,
    top_source_controls: pickTopActionCandidates(sourceControls, "high"),
    top_player_targets: pickTopActionCandidates(playerTargets, "high"),
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
