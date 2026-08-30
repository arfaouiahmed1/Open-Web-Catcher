import { inspect } from './inspect.js';
import { buildPlayerHandoffCandidates } from './player-handoff.js';
import { DEFAULT_BUDGETS, buildRawCounts, commonReducers, fitPayloadToBudget } from './inspect-summaries.js';

const MATCH_PATTERN = /(watch|live|stream|match|fixture|kickoff|vs|versus|channel|game|event|play|league|cup|sports?)/i;
const NOISE_PATTERN = /(login|sign in|signup|register|privacy|terms|cookie|contact|about|help|faq|telegram|discord|twitter|facebook|instagram)/i;

const MAX_MATCH_CANDIDATES = 120;
const MAX_NAV_LINKS = 50;
const MAX_ACTION_TARGETS = 40;
const MAX_IFRAME_FRAMES = 24;

const clean = (value, max = 160) =>
  String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function dedupeBy(items, keyFn, limit = 100) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function inferMetadata(text, url) {
  const normalized = clean(text, 180);
  const metadata = {
    participants: null,
    status: /\blive\b/i.test(normalized) ? 'live' : /replay|vod/i.test(normalized) ? 'replay' : /upcoming|soon|today|tomorrow/i.test(normalized) ? 'upcoming' : 'unknown',
    scheduled_time: null,
    channel: null,
    competition: null,
  };

  const participantsMatch = normalized.match(/([\w .'-]{2,})\s+(?:vs|v|versus)\s+([\w .'-]{2,})/i);
  if (participantsMatch) {
    metadata.participants = `${clean(participantsMatch[1], 60)} vs ${clean(participantsMatch[2], 60)}`;
  }

  const timeMatch = normalized.match(/\b(\d{1,2}:\d{2}\s?(?:am|pm)?)\b/i);
  if (timeMatch) {
    metadata.scheduled_time = timeMatch[1].toUpperCase();
  }

  const channelMatch = normalized.match(/(?:channel|tv)\s*[:\-]?\s*([\w .'-]{2,40})/i);
  if (channelMatch) {
    metadata.channel = clean(channelMatch[1], 40);
  }

  const competitionMatch = normalized.match(/(?:league|cup|championship|tournament)\s*[:\-]?\s*([\w .'-]{2,50})/i);
  if (competitionMatch) {
    metadata.competition = clean(competitionMatch[1], 50);
  }

  if (!metadata.channel && /channel|tv/i.test(url || '')) {
    metadata.channel = 'possible_channel_link';
  }

  return metadata;
}

function candidateScore(candidate) {
  const haystack = `${candidate.text} ${candidate.url}`.toLowerCase();
  let score = 0;
  if (MATCH_PATTERN.test(haystack)) score += 8;
  if (/\b(vs|versus)\b/.test(haystack)) score += 6;
  if (/\blive\b/.test(haystack)) score += 5;
  if (/watch|play|stream/.test(haystack)) score += 4;
  if (candidate.frame_path !== 'root') score += 2;
  if (candidate.metadata?.participants) score += 4;
  return score;
}

function normalizeLink(entry, source, framePath = 'root') {
  return {
    url: entry.href || entry.url || '',
    text: clean(entry.text, 180),
    selector: entry.selector || '',
    xpath: entry.xpath || '',
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    width: Math.round(entry.width || 0),
    height: Math.round(entry.height || 0),
    frame_path: framePath,
    source,
  };
}

function toNavLink(entry) {
  return {
    url: entry.href || '',
    text: clean(entry.text, 120),
    selector: entry.selector || '',
    xpath: entry.xpath || '',
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
  };
}

function toActionTarget(entry) {
  return {
    kind: entry.kind || entry.type || entry.tag || 'unknown',
    text: clean(entry.text, 120),
    selector: entry.selector || '',
    xpath: entry.xpath || '',
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    width: Math.round(entry.width || 0),
    height: Math.round(entry.height || 0),
    frame_path: entry.frame_path || 'root',
  };
}

function toFrameOverview(frame) {
  return {
    frame_path: frame.frame_path,
    parent_frame_path: frame.parent_frame_path,
    depth: frame.depth,
    url: frame.url,
    purpose_hint: frame.purpose_hint,
    video_count: frame.video_count,
    total_links: frame.total_links,
    total_buttons: frame.total_buttons,
    has_server_controls: frame.has_server_controls,
    sample_links: (frame.sample_links || []).map((entry) => ({
      url: entry.href || '',
      text: clean(entry.text, 120),
      selector: entry.selector || '',
      xpath: entry.xpath || '',
      x: Math.round(entry.x || 0),
      y: Math.round(entry.y || 0),
    })).slice(0, 6),
  };
}

export async function inspectLanding(params = {}) {
  const data = await inspect({ ...params, scanMode: 'landing' });

  const rootMatchLinks = (data.contentLinks || []).map((entry) => normalizeLink(entry, 'root-content', 'root'));
  const iframeMatchLinks = (data.frame_tree || [])
    .flatMap((frame) =>
      (frame.sample_links || []).map((entry) => normalizeLink(entry, 'iframe-sample', frame.frame_path)));

  const match_candidates = dedupeBy(
    [...rootMatchLinks, ...iframeMatchLinks]
      .filter((entry) => entry.url && !entry.url.startsWith('javascript:'))
      .filter((entry) => !NOISE_PATTERN.test(`${entry.text} ${entry.url}`))
      .map((entry) => ({ ...entry, metadata: inferMetadata(entry.text, entry.url) }))
      .map((entry) => ({ ...entry, relevance_score: candidateScore(entry) }))
      .sort((a, b) => b.relevance_score - a.relevance_score),
    (entry) => `${entry.frame_path}|${entry.url}`,
    MAX_MATCH_CANDIDATES,
  );

  const navigation_links = dedupeBy(
    (data.navLinks || [])
      .map(toNavLink)
      .filter((entry) => entry.url)
      .filter((entry) => !NOISE_PATTERN.test(`${entry.text} ${entry.url}`)),
    (entry) => entry.url,
    MAX_NAV_LINKS,
  );

  const action_targets = dedupeBy(
    [...(data.buttons || []), ...(data.elements || []).filter((entry) => ['button', 'tab', 'select'].includes(entry.kind || entry.type))]
      .map(toActionTarget)
      .filter((entry) => entry.selector || entry.xpath || entry.text),
    (entry) => `${entry.frame_path}|${entry.selector}|${entry.xpath}|${entry.text}`,
    MAX_ACTION_TARGETS,
  );

  const iframeFrames = (data.frame_tree || [])
    .filter((frame) => !frame.is_main_frame)
    .sort((a, b) => (b.total_links + b.video_count + b.total_buttons) - (a.total_links + a.video_count + a.total_buttons))
    .slice(0, MAX_IFRAME_FRAMES)
    .map(toFrameOverview);

  const maxDepth = (data.frame_tree || []).reduce((max, frame) => Math.max(max, frame.depth || 0), 0);

  // Budget-first reduction (plan T20-d): MAX_* caps only pre-shape the payload;
  // final size is governed by the per-profile byte budget with staged reducers.
  const fitted = fitPayloadToBudget(
    {
      context_type: 'landing',
      url: data.url,
      title: data.title,
      screenshot_url: data.screenshot_url,
      hosting_signals: data.hosting_signals,
      lazy_load_warmup: data.lazy_load_warmup,
      pagination: data.pagination,
      popups: (data.popups || []).slice(0, 8),
      match_candidates,
      navigation_links,
      action_targets,
      player_handoff_candidates: buildPlayerHandoffCandidates(data),
      iframe_overview: {
        total_frames: (data.frame_tree || []).length,
        max_depth: maxDepth,
        frames_with_video: (data.frame_tree || []).filter((frame) => frame.video_count > 0).length,
        frames_with_links: (data.frame_tree || []).filter((frame) => frame.total_links > 0).length,
        frames: iframeFrames,
      },
      stats: {},
    },
    {
      budgetTarget: DEFAULT_BUDGETS.landing,
      rawCounts: buildRawCounts(data),
      reducers: commonReducers({
        groupCollections: () => [],
        primaryCandidateCollections: [
          (result) => result.match_candidates,
          (result) => result.action_targets,
        ],
        secondaryCandidateCollections: [(result) => result.navigation_links],
        frameCollections: [(result) => result.iframe_overview.frames],
        groupDetailCollections: [
          (result) => (result.iframe_overview.frames || []).map((frame) => frame.sample_links || []),
        ],
        miscCollections: [
          (result) => result.popups,
          (result) => result.player_handoff_candidates,
        ],
      }),
    },
  );

  fitted.stats = {
    ...(data.stats || {}),
    match_candidates: fitted.match_candidates.length,
    navigation_links: fitted.navigation_links.length,
    action_targets: fitted.action_targets.length,
    iframe_frames_reported: fitted.iframe_overview.frames.length,
  };
  return fitted;
}
