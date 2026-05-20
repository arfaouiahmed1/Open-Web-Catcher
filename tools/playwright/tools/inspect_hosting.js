import { inspect } from './inspect.js';
import { buildPlayerHandoffCandidates } from './player-handoff.js';

const SERVER_PATTERN = /(server|source|mirror|backup|embed|stream|quality|cdn)/i;
const PLAY_PATTERN = /(play|watch|start|resume|stream)/i;

const MAX_SERVER_CONTROLS = 60;
const MAX_PLAYBACK_TARGETS = 45;
const MAX_IFRAME_FRAMES = 30;

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

function frameScore(frame) {
  let score = 0;
  score += (frame.video_count || 0) * 6;
  score += (frame.has_player_library ? 8 : 0);
  score += (frame.has_server_controls ? 6 : 0);
  score += (frame.total_buttons || 0) > 0 ? 2 : 0;
  score += (frame.purpose_hint === 'player' ? 6 : 0);
  return score;
}

function toFrameContext(frame) {
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
    has_player_library: frame.has_player_library,
    score: frameScore(frame),
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
  };
}

export async function inspectHosting(params = {}) {
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

  const server_controls = dedupeBy(
    allTargets
      .filter((entry) => entry.selector || entry.xpath)
      .filter((entry) => {
        const haystack = `${entry.text} ${entry.selector} ${entry.xpath} ${entry.href} ${entry.data?.server || ''} ${entry.data?.source || ''}`;
        return SERVER_PATTERN.test(haystack);
      })
      .sort((a, b) => (b.frame_path === 'root' ? 0 : 1) - (a.frame_path === 'root' ? 0 : 1)),
    (entry) => `${entry.frame_path}|${entry.selector}|${entry.xpath}|${entry.text}`,
    MAX_SERVER_CONTROLS,
  );

  const playback_targets = dedupeBy(
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
      ...allTargets.filter((entry) => PLAY_PATTERN.test(`${entry.text} ${entry.selector} ${entry.xpath}`)),
    ],
    (entry) => `${entry.frame_path}|${entry.selector}|${entry.xpath}|${entry.text}`,
    MAX_PLAYBACK_TARGETS,
  );

  const iframe_context = (data.frame_tree || [])
    .filter((frame) => !frame.is_main_frame)
    .sort((a, b) => frameScore(b) - frameScore(a))
    .slice(0, MAX_IFRAME_FRAMES)
    .map(toFrameContext);

  return {
    context_type: 'hosting',
    url: data.url,
    title: data.title,
    screenshot_url: data.screenshot_url,
    hosting_signals: data.hosting_signals,
    videos: (data.videos || []).slice(0, 12),
    popups: (data.popups || []).slice(0, 8),
    server_controls,
    playback_targets,
    player_handoff_candidates: buildPlayerHandoffCandidates(data),
    iframe_context: {
      total_frames: (data.frame_tree || []).length,
      max_depth: (data.frame_tree || []).reduce((max, frame) => Math.max(max, frame.depth || 0), 0),
      frames_with_video: (data.frame_tree || []).filter((frame) => frame.video_count > 0).length,
      frames_with_server_controls: (data.frame_tree || []).filter((frame) => frame.has_server_controls).length,
      frames: iframe_context,
    },
    stats: {
      ...(data.stats || {}),
      server_controls: server_controls.length,
      playback_targets: playback_targets.length,
      iframe_frames_reported: iframe_context.length,
    },
  };
}
