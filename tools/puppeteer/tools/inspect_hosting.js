import { inspect } from "./inspect.js";

const SERVER_PATTERN =
  /(server|source|mirror|backup|embed|stream|quality|cdn)/i;
const PLAY_PATTERN = /(play|watch|start|resume|stream)/i;
const STREAM_PATTERN =
  /\.m3u8|\.mpd|video\/|audio\/|application\/vnd\.apple\.mpegurl|dash\+xml/i;

const normalizeWhitespace = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

function frameScore(frame) {
  let score = 0;
  score += Number(frame.video_count || 0) * 6;
  score += frame.has_player_library ? 8 : 0;
  score += frame.has_server_controls ? 6 : 0;
  score += Number(frame.total_buttons || 0) > 0 ? 2 : 0;
  score += frame.purpose_hint === "player" ? 6 : 0;
  return score;
}

function dedupeByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function toFrameContext(frame) {
  return {
    frame_path: frame.frame_path,
    parent_frame_path: frame.parent_frame_path,
    depth: frame.depth,
    url: frame.url,
    purpose_hint: frame.purpose_hint,
    score: frameScore(frame),
    video_count: frame.video_count,
    total_links: frame.total_links,
    total_buttons: frame.total_buttons,
    total_iframes: frame.total_iframes,
    has_server_controls: frame.has_server_controls,
    has_player_library: frame.has_player_library,
    player_libraries_detail: frame.player_libraries_detail || {},
    links: frame.links || frame.sample_links || [],
    buttons: frame.buttons || frame.sample_buttons || [],
    error: frame.error || null,
  };
}

function buildRequestsByFrame(requests = []) {
  const counts = new Map();
  for (const request of requests) {
    const key = request.frame_url || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([frame_url, count]) => ({
    frame_url,
    count,
  }));
}

function buildRequestsByType(requests = []) {
  const counts = new Map();
  for (const request of requests) {
    const key = request.resource_type || "other";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([resource_type, count]) => ({
    resource_type,
    count,
  }));
}

function collectServerControlCandidates(data) {
  const rootTargets = [...(data.buttons || []), ...(data.elements || [])];
  const frameTargets = (data.frame_tree || []).flatMap((frame) => [
    ...(frame.buttons || frame.sample_buttons || []),
    ...(frame.links || frame.sample_links || []),
  ]);

  return dedupeByKey(
    [...rootTargets, ...frameTargets]
      .filter((entry) => entry.selector || entry.xpath || entry.text)
      .filter((entry) =>
        SERVER_PATTERN.test(
          `${entry.text || ""} ${entry.selector || ""} ${entry.xpath || ""} ${entry.href || ""} ${JSON.stringify(entry.data || {})}`,
        ),
      ),
    (entry) =>
      `${entry.frame_path || "root"}|${entry.selector || ""}|${entry.xpath || ""}|${entry.text || ""}`,
  );
}

function collectPlaybackTargets(data) {
  const fromVideos = (data.videos || []).map((video) => ({
    kind: "video",
    text: video.src || video.current_src || "video",
    selector: video.selector || "",
    xpath: video.xpath || "",
    x: Math.round(video.x || 0),
    y: Math.round(video.y || 0),
    width: Math.round(video.width || 0),
    height: Math.round(video.height || 0),
    frame_path: "root",
    ready_state: video.readyState,
    paused: video.paused,
  }));

  const fromElements = [
    ...(data.buttons || []),
    ...(data.elements || []),
  ].filter((entry) =>
    PLAY_PATTERN.test(
      `${entry.text || ""} ${entry.selector || ""} ${entry.xpath || ""}`,
    ),
  );

  return dedupeByKey(
    [...fromVideos, ...fromElements],
    (entry) =>
      `${entry.frame_path || "root"}|${entry.selector || ""}|${entry.xpath || ""}|${entry.text || ""}`,
  );
}

export async function inspectHosting(params = {}) {
  const data = await inspect({
    ...params,
    scanMode: "hosting",
    include_network: params.include_network ?? true,
    include_response_bodies: params.include_response_bodies ?? false,
    include_frames: params.include_frames ?? true,
  });

  const frameTree = Array.isArray(data.frame_tree) ? data.frame_tree : [];
  const rankedFrames = [...frameTree]
    .sort((a, b) => frameScore(b) - frameScore(a))
    .map(toFrameContext);
  const requests = data.network?.requests || [];
  const responses = data.network?.responses || [];
  const mediaLikeRequests = requests.filter((request) =>
    STREAM_PATTERN.test(`${request.url || ""} ${request.resource_type || ""}`),
  );
  const mediaLikeResponses = responses.filter((response) =>
    STREAM_PATTERN.test(`${response.url || ""} ${response.content_type || ""}`),
  );

  return {
    ...data,
    context_type: "hosting",
    inspect_profile: "hosting",
    focus: {
      primary: ["frames", "network", "media"],
      secondary: ["interactive_elements", "links"],
    },
    iframe_depth_summary: {
      total_frames: frameTree.length,
      max_depth: frameTree.reduce(
        (max, frame) => Math.max(max, Number(frame.depth || 0)),
        0,
      ),
      frames_with_video: frameTree.filter(
        (frame) => Number(frame.video_count || 0) > 0,
      ).length,
      frames_with_server_controls: frameTree.filter(
        (frame) => frame.has_server_controls,
      ).length,
      ranked_frames: rankedFrames,
    },
    network_focus: {
      total_requests: requests.length,
      total_responses: responses.length,
      resource_summary: data.network?.resource_summary || {},
      requests_by_type: buildRequestsByType(requests),
      requests_by_frame: buildRequestsByFrame(requests),
      media_like_requests,
      media_like_responses,
    },
    server_control_candidates: collectServerControlCandidates(data),
    playback_targets: collectPlaybackTargets(data),
  };
}
