import { inspect } from './inspect.js';
import { buildPlayerHandoffCandidates } from './player-handoff.js';

const SOURCE_PATTERN = /(server|source|mirror|backup|quality|audio|sub|embed|stream)/i;
const PLAY_PATTERN = /(play|watch|start|resume|tap|stream)/i;

const MAX_SOURCE_CONTROLS = 70;
const MAX_PLAYER_TARGETS = 50;
const MAX_FRAME_FOCUS = 30;

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

function normalizeTarget(entry, framePath = 'root') {
  return {
    kind: entry.kind || entry.type || entry.tag || 'unknown',
    text: clean(entry.text, 140),
    selector: entry.selector || '',
    xpath: entry.xpath || '',
    x: Math.round(entry.x || 0),
    y: Math.round(entry.y || 0),
    width: Math.round(entry.width || 0),
    height: Math.round(entry.height || 0),
    href: entry.href || '',
    frame_path: entry.frame_path || framePath,
    data: entry.data || {},
  };
}

function activationReason(entry) {
  const haystack = `${entry.kind || ''} ${entry.text || ''} ${entry.selector || ''} ${entry.xpath || ''}`.toLowerCase();
  if (entry.kind === 'video') return 'visible video element';
  if (/play|watch|start|resume|unmute|go live/.test(haystack)) return 'explicit play-like control';
  if (/player|poster|overlay|control|video-js|jwplayer|plyr/.test(haystack)) return 'player surface or overlay';
  if (entry.href) return 'player-like link target';
  return 'candidate from player/media region';
}

function buildActivationCandidates(targets, limit = 16) {
  return (targets || []).slice(0, limit).map((entry) => ({
    ...entry,
    activation_reason: activationReason(entry),
    requires_agent_choice: true,
  }));
}

function buildBlockerCandidates(popups, limit = 10) {
  return (popups || []).slice(0, limit).map((popup, index) => ({
    kind: 'popup_or_overlay',
    text: clean(popup.text, 120),
    selector: popup.selector || '',
    xpath: popup.xpath || '',
    close_selector: popup.close_selector || '',
    close_xpath: popup.close_xpath || '',
    frame_path: 'root',
    blocker_reason: 'visible popup/modal/overlay candidate',
    requires_agent_choice: true,
    index,
  }));
}

function frameFocusScore(frame) {
  let score = 0;
  score += (frame.video_count || 0) * 7;
  score += frame.has_player_library ? 10 : 0;
  score += frame.has_server_controls ? 7 : 0;
  score += frame.purpose_hint === 'player' ? 9 : 0;
  score += (frame.total_buttons || 0) > 0 ? 2 : 0;
  return score;
}

function toFrameFocus(frame) {
  return {
    frame_path: frame.frame_path,
    parent_frame_path: frame.parent_frame_path,
    depth: frame.depth,
    url: frame.url,
    purpose_hint: frame.purpose_hint,
    score: frameFocusScore(frame),
    video_count: frame.video_count,
    total_buttons: frame.total_buttons,
    total_links: frame.total_links,
    has_server_controls: frame.has_server_controls,
    has_player_library: frame.has_player_library,
    sample_buttons: (frame.sample_buttons || []).map((entry) => ({
      text: clean(entry.text, 120),
      selector: entry.selector || '',
      xpath: entry.xpath || '',
      x: Math.round(entry.x || 0),
      y: Math.round(entry.y || 0),
    })).slice(0, 6),
    sample_links: (frame.sample_links || []).map((entry) => ({
      url: entry.href || '',
      text: clean(entry.text, 120),
      selector: entry.selector || '',
      xpath: entry.xpath || '',
      x: Math.round(entry.x || 0),
      y: Math.round(entry.y || 0),
    })).slice(0, 6),
    sample_videos: (frame.sample_videos || []).map((video) => ({
      kind: 'video',
      text: clean(video.src || 'video', 120),
      selector: video.selector || '',
      xpath: video.xpath || '',
      x: Math.round(video.x || 0),
      y: Math.round(video.y || 0),
      width: Math.round(video.width || 0),
      height: Math.round(video.height || 0),
      frame_path: frame.frame_path,
      ready_state: Number(video.readyState ?? video.ready_state ?? 0),
      paused: Boolean(video.paused),
    })).slice(0, 6),
  };
}

function frameVideoTargets(data) {
  return (data.frame_tree || []).flatMap((frame) =>
    (frame.sample_videos || []).map((video) => ({
      kind: 'video',
      text: clean(video.src || 'video', 120),
      selector: video.selector || '',
      xpath: video.xpath || '',
      x: Math.round(video.x || 0),
      y: Math.round(video.y || 0),
      width: Math.round(video.width || 0),
      height: Math.round(video.height || 0),
      frame_path: frame.frame_path || 'root',
      ready_state: Number(video.readyState ?? video.ready_state ?? 0),
      paused: Boolean(video.paused),
    })),
  );
}

export async function inspectEmbedded(params = {}) {
  const data = await inspect(params);

  const rootTargets = [
    ...(data.buttons || []).map((entry) => normalizeTarget(entry, 'root')),
    ...(data.elements || []).map((entry) => normalizeTarget(entry, entry.frame_path || 'root')),
  ];

  const frameTargets = (data.frame_tree || []).flatMap((frame) => (
    [
      ...(frame.sample_buttons || []).map((entry) => normalizeTarget(entry, frame.frame_path)),
      ...(frame.sample_links || []).map((entry) => normalizeTarget(entry, frame.frame_path)),
    ]
  ));

  const allTargets = [...rootTargets, ...frameTargets];

  const source_controls = dedupeBy(
    allTargets
      .filter((entry) => entry.selector || entry.xpath)
      .filter((entry) => {
        const haystack = `${entry.text} ${entry.selector} ${entry.xpath} ${entry.href} ${entry.data?.server || ''} ${entry.data?.source || ''} ${entry.data?.embed || ''}`;
        return SOURCE_PATTERN.test(haystack);
      })
      .sort((a, b) => {
        const aFrameDepth = (a.frame_path.match(/\./g) || []).length;
        const bFrameDepth = (b.frame_path.match(/\./g) || []).length;
        return bFrameDepth - aFrameDepth;
      }),
    (entry) => `${entry.frame_path}|${entry.selector}|${entry.xpath}|${entry.text}`,
    MAX_SOURCE_CONTROLS,
  );

  const player_targets = dedupeBy(
    [
      ...(data.videos || []).map((video) => ({
        kind: 'video',
        text: clean(video.src || 'video', 120),
        selector: video.selector || '',
        xpath: video.xpath || '',
        x: Math.round(video.x || 0),
        y: Math.round(video.y || 0),
        width: Math.round(video.width || 0),
        height: Math.round(video.height || 0),
        frame_path: 'root',
        ready_state: video.readyState,
        paused: video.paused,
      })),
      ...frameVideoTargets(data),
      ...allTargets.filter((entry) => PLAY_PATTERN.test(`${entry.text} ${entry.selector} ${entry.xpath}`)),
    ],
    (entry) => `${entry.frame_path}|${entry.selector}|${entry.xpath}|${entry.text}`,
    MAX_PLAYER_TARGETS,
  );

  const frame_focus_order = (data.frame_tree || [])
    .sort((a, b) => frameFocusScore(b) - frameFocusScore(a))
    .slice(0, MAX_FRAME_FOCUS)
    .map(toFrameFocus);

  return {
    context_type: 'embedded',
    url: data.url,
    title: data.title,
    screenshot_url: data.screenshot_url,
    hosting_signals: data.hosting_signals,
    videos: (data.videos || []).slice(0, 12),
    popups: (data.popups || []).slice(0, 8),
    source_controls,
    player_targets,
    activation_candidates: buildActivationCandidates(player_targets),
    blocker_candidates: buildBlockerCandidates(data.popups),
    player_handoff_candidates: buildPlayerHandoffCandidates(data),
    frame_focus_order,
    iframe_context: {
      total_frames: (data.frame_tree || []).length,
      max_depth: (data.frame_tree || []).reduce((max, frame) => Math.max(max, frame.depth || 0), 0),
      frames_with_video: (data.frame_tree || []).filter((frame) => frame.video_count > 0).length,
      frames_with_server_controls: (data.frame_tree || []).filter((frame) => frame.has_server_controls).length,
    },
    stats: {
      ...(data.stats || {}),
      source_controls: source_controls.length,
      player_targets: player_targets.length,
      activation_candidates: Math.min(player_targets.length, 16),
      blocker_candidates: Math.min((data.popups || []).length, 10),
      frame_focus_candidates: frame_focus_order.length,
    },
  };
}
