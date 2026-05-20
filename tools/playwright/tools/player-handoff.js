const STREAM_URL_PATTERN = /(\.(m3u8|mpd|mp4|m4s|ts)(?:$|[?#])|\/(?:hls|dash|m3u8|mpd|manifest|playlist|tracks[^/]*)\/|(?:^|[?&])(format|type|protocol)=(hls|dash|m3u8|mpd)|(?:^|\/)(master|index|chunklist|playlist|manifest)(?:[.-]|$)|(?:^|\/)mono(?:[.-]|$).*?(token=|expires=))/i;
const DIRECT_PLAYER_URL_PATTERN = /(embed|player|iframe|\/e\/|\/v\/|\/video\/|\/watch\/|stream)/i;

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

function looksLikelyStreamUrl(url) {
  const candidate = String(url || '').trim();
  if (!/^https?:\/\//i.test(candidate)) return false;
  return STREAM_URL_PATTERN.test(candidate);
}

function looksLikelyDirectPlayerUrl(url) {
  const candidate = String(url || '').trim();
  if (!/^https?:\/\//i.test(candidate)) return false;
  if (looksLikelyStreamUrl(candidate)) return false;
  return DIRECT_PLAYER_URL_PATTERN.test(candidate);
}

export function buildPlayerHandoffCandidates(data, { limit = 28 } = {}) {
  const rows = [];
  const add = (entry) => {
    const url = String(entry.url || entry.src || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    rows.push({
      type: entry.type || 'unknown',
      url,
      frame_path: entry.frame_path || 'root',
      selector: entry.selector || '',
      xpath: entry.xpath || '',
      label: clean(entry.label || entry.text || '', 100),
      likely_stream: looksLikelyStreamUrl(url),
      likely_direct_embed: looksLikelyDirectPlayerUrl(url),
      ready_state: entry.ready_state ?? null,
      paused: entry.paused ?? null,
    });
  };

  for (const frame of data.iframes || []) {
    add({
      type: 'iframe_src',
      url: frame.src || '',
      selector: frame.selector || '',
      xpath: frame.xpath || '',
      label: frame.category || '',
    });
  }
  for (const video of data.videos || []) {
    add({
      type: 'video_src',
      url: video.src || '',
      selector: video.selector || '',
      xpath: video.xpath || '',
      ready_state: Number(video.readyState ?? video.ready_state ?? 0),
      paused: Boolean(video.paused),
    });
    for (const source of video.sources || []) {
      add({
        type: 'video_source',
        url: source,
        selector: video.selector || '',
        xpath: video.xpath || '',
      });
    }
  }
  for (const frame of data.frame_tree || []) {
    if (frame.is_main_frame) continue;
    if (frame.purpose_hint === 'player' || frame.video_count > 0 || frame.has_player_library) {
      add({
        type: 'frame_url',
        url: frame.url || '',
        frame_path: frame.frame_path || 'root',
        label: frame.purpose_hint || '',
      });
    }
    for (const video of frame.sample_videos || []) {
      add({
        type: 'frame_video_src',
        url: video.src || '',
        frame_path: frame.frame_path || 'root',
        selector: video.selector || '',
        xpath: video.xpath || '',
        ready_state: Number(video.readyState ?? 0),
        paused: Boolean(video.paused),
      });
      for (const source of video.sources || []) {
        add({
          type: 'frame_video_source',
          url: source,
          frame_path: frame.frame_path || 'root',
          selector: video.selector || '',
          xpath: video.xpath || '',
        });
      }
    }
  }

  return dedupeBy(
    rows
      .filter((entry) => entry.likely_stream || entry.likely_direct_embed || entry.type.includes('iframe') || entry.type.includes('frame'))
      .sort((a, b) => Number(b.likely_stream || b.likely_direct_embed) - Number(a.likely_stream || a.likely_direct_embed)),
    (entry) => `${entry.type}|${entry.url}|${entry.frame_path}`,
    limit,
  );
}
