import { inspect } from "./inspect.js";

const SOURCE_PATTERN =
  /(server|source|mirror|backup|quality|audio|sub|embed|stream)/i;
const PLAY_PATTERN = /(play|watch|start|resume|tap|stream)/i;
const STREAM_PATTERN =
  /\.m3u8|\.mpd|video\/|audio\/|application\/vnd\.apple\.mpegurl|dash\+xml/i;

function frameFocusScore(frame) {
  let score = 0;
  score += Number(frame.depth || 0) * 4;
  score += Number(frame.video_count || 0) * 7;
  score += frame.has_player_library ? 10 : 0;
  score += frame.has_server_controls ? 7 : 0;
  score += frame.purpose_hint === "player" ? 9 : 0;
  score += Number(frame.total_buttons || 0) > 0 ? 2 : 0;
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

function collectSourceControlCandidates(data) {
  const rootTargets = [...(data.buttons || []), ...(data.elements || [])];
  const frameTargets = (data.frame_tree || []).flatMap((frame) => [
    ...(frame.buttons || frame.sample_buttons || []),
    ...(frame.links || frame.sample_links || []),
  ]);

  return dedupeByKey(
    [...rootTargets, ...frameTargets]
      .filter((entry) => entry.selector || entry.xpath || entry.text)
      .filter((entry) =>
        SOURCE_PATTERN.test(
          `${entry.text || ""} ${entry.selector || ""} ${entry.xpath || ""} ${entry.href || ""} ${JSON.stringify(entry.data || {})}`,
        ),
      ),
    (entry) =>
      `${entry.frame_path || "root"}|${entry.selector || ""}|${entry.xpath || ""}|${entry.text || ""}`,
  );
}

function collectPlayerTargets(data) {
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

export async function inspectEmbedded(params = {}) {
  const data = await inspect({
    ...params,
    scanMode: "embedded",
    max_depth: params.max_depth ?? 8,
    max_children_per_node: params.max_children_per_node ?? 55,
    max_links: params.max_links ?? 320,
    max_interactive_elements: params.max_interactive_elements ?? 350,
    max_images: params.max_images ?? 180,
    max_sources: params.max_sources ?? 200,
    max_forms: params.max_forms ?? 30,
    max_form_inputs: params.max_form_inputs ?? 34,
    max_table_rows: params.max_table_rows ?? 50,
    max_frames: params.max_frames ?? 24,
    frame_eval_timeout_ms: params.frame_eval_timeout_ms ?? 7000,
    include_network: params.include_network ?? true,
    include_response_bodies: params.include_response_bodies ?? false,
    include_frames: params.include_frames ?? true,
  });

  const frameTree = Array.isArray(data.frame_tree) ? data.frame_tree : [];
  const requests = data.network?.requests || [];
  const responses = data.network?.responses || [];
  const rankedFrames = [...frameTree]
    .sort((a, b) => frameFocusScore(b) - frameFocusScore(a))
    .map(toFrameFocus);
  const mediaLikeRequests = requests.filter((request) =>
    STREAM_PATTERN.test(`${request.url || ""} ${request.resource_type || ""}`),
  );
  const mediaLikeResponses = responses.filter((response) =>
    STREAM_PATTERN.test(`${response.url || ""} ${response.content_type || ""}`),
  );

  return {
    ...data,
    context_type: "embedded",
    inspect_profile: "embedded",
    focus: {
      primary: ["nested_frames", "network", "media"],
      secondary: ["interactive_elements", "links"],
    },
    nested_iframe_summary: {
      total_frames: frameTree.length,
      max_depth: frameTree.reduce(
        (max, frame) => Math.max(max, Number(frame.depth || 0)),
        0,
      ),
      deepest_frames: [...frameTree]
        .sort((a, b) => Number(b.depth || 0) - Number(a.depth || 0))
        .map(toFrameFocus),
      frame_focus_order: rankedFrames,
      frames_with_video: frameTree.filter(
        (frame) => Number(frame.video_count || 0) > 0,
      ).length,
      frames_with_server_controls: frameTree.filter(
        (frame) => frame.has_server_controls,
      ).length,
    },
    network_focus: {
      total_requests: requests.length,
      total_responses: responses.length,
      resource_summary: data.network?.resource_summary || {},
      requests_by_frame: buildRequestsByFrame(requests),
      media_like_requests: mediaLikeRequests,
      media_like_responses: mediaLikeResponses,
    },
    source_control_candidates: collectSourceControlCandidates(data),
    player_targets: collectPlayerTargets(data),
  };
}
