/**
 * shared/media-activation.js - Shared playback activation pipeline.
 *
 * Ported from tools/puppeteer/shared/media-activation.js (plan T20 / [TOOL-P3]
 * + [TOOL-DUP] dedupe target). Playwright's Frame/ElementHandle/page.mouse
 * APIs match the Puppeteer surface used here (evaluate(fn, arg), childFrames(),
 * parentFrame(), boundingBox(), click()), so the pipeline ports 1:1; the only
 * intentional divergence is the browserId default ("playwright") used to
 * resolve per-engine runtime settings.
 *
 * Consumers:
 *  - tools/action-tools.js (play_media) imports the probe/preflight helpers
 *    from here instead of keeping drifted local copies;
 *  - tools/interact.js ('play' mode) drives activatePlayback directly,
 *    mirroring puppeteer interact.js:185 wiring.
 */

import { getBrowserRuntimeSettings } from "./runtime-config.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PLAY_ACTION_PATTERN = /(play|watch|resume|start|continue|tap|unmute|go live)/i;
const BLOCKER_ACTION_PATTERN = /(close|dismiss|accept|agree|allow|skip|ok|got it|x)/i;
const SOURCE_SWITCH_PATTERN = /(server|source|mirror|backup|quality|audio|sub|caption|language|idioma|option|stream\s*\d+|link\s*\d+)/i;

function deriveFramePath(frame) {
  if (!frame?.parentFrame?.()) return "root";

  const segments = [];
  let current = frame;
  while (current.parentFrame()) {
    const parent = current.parentFrame();
    const index = parent.childFrames().indexOf(current);
    segments.unshift(String(Math.max(index, 0)));
    current = parent;
  }

  return segments.length ? `root.${segments.join(".")}` : "root";
}

function runtimeSetting(browserId, key) {
  return getBrowserRuntimeSettings(browserId)?.[key];
}

function parseBoolean(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function parseInteger(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, parsed);
}

function parseIntegerList(value, fallback = []) {
  const rows = Array.isArray(value) ? value : fallback;
  const normalized = rows
    .map((item) => Number.parseInt(String(item ?? "").trim(), 10))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return normalized.length ? normalized : fallback;
}

export function getMediaRuntimeConfig(browserId = "playwright") {
  const configuredAttempts = parseInteger(runtimeSetting(browserId, "media_retry_count"), 3, 1);
  return {
    total_attempts: configuredAttempts,
    retry_backoff_ms: parseIntegerList(runtimeSetting(browserId, "media_retry_backoff_ms"), [1000, 2000, 4000]),
    verify_playback: parseBoolean(runtimeSetting(browserId, "media_playback_verification_enabled"), true),
    verification_timeout_ms: parseInteger(
      runtimeSetting(browserId, "media_playback_verification_timeout_ms"),
      5000,
      500,
    ),
    settle_after_action_ms: parseInteger(
      runtimeSetting(browserId, "media_activation_settle_ms"),
      350,
      50,
    ),
    candidate_limit: parseInteger(
      runtimeSetting(browserId, "media_activation_candidate_limit"),
      6,
      1,
    ),
    preflight_action_limit: parseInteger(
      runtimeSetting(browserId, "media_preflight_action_limit"),
      3,
      0,
    ),
  };
}

function buildCoordinatePoint(box) {
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return null;
  return {
    x: Math.round(box.x + (box.width || 0) / 2),
    y: Math.round(box.y + (box.height || 0) / 2),
  };
}

async function clickCoordinates(page, x, y) {
  const midX = x * 0.6 + Math.random() * 40;
  const midY = y * 0.6 + Math.random() * 40;
  await page.mouse.move(midX, midY, { steps: 8 });
  await wait(40);
  await page.mouse.move(x, y, { steps: 6 });
  await wait(30);
  await page.mouse.click(x, y);
}

async function inspectFrameForPlayback(frame, { candidateLimit = 6 } = {}) {
  return frame.evaluate(({ candidateLimit: limit }) => {
    const normalize = (value, max = 140) =>
      String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

    const visible = (node) => {
      if (!(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style) return false;
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
      if (Number(style.opacity || "1") === 0) return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };

    const scoreNode = (node) => {
      const rect = node.getBoundingClientRect();
      const text = normalize(
        node.innerText
          || node.textContent
          || node.getAttribute?.("aria-label")
          || node.getAttribute?.("title")
          || node.getAttribute?.("value")
          || "",
      );
      const className = String(node.className || "").toLowerCase();
      const role = String(node.getAttribute?.("role") || "").toLowerCase();
      const tag = String(node.tagName || "").toLowerCase();
      const attrs = `${className} ${role} ${text}`.toLowerCase();
      const explicitPlay = /(play|watch|resume|start|continue|tap|unmute|go live)/.test(attrs);
      const sourceSwitch = /(server|source|mirror|backup|quality|audio|sub|caption|language|idioma|option|stream\s*\d+|link\s*\d+)/.test(attrs) && !explicitPlay;
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const nodeCenterX = rect.left + rect.width / 2;
      const nodeCenterY = rect.top + rect.height / 2;
      const distance = Math.hypot(centerX - nodeCenterX, centerY - nodeCenterY);
      const area = rect.width * rect.height;
      let score = 0;
      let kind = "control";

      if (tag === "video") {
        score += 120;
        kind = "video";
      }
      if (explicitPlay) score += 55;
      if (/(player|poster|overlay|control|button|video-js|jwplayer|plyr)/.test(attrs)) score += 24;
      if (/(close|dismiss|accept|agree|allow|skip|ok|continue|got it|×|x|✕)/.test(attrs)) score += 18;
      if (role === "button" || tag === "button" || tag === "a" || node.getAttribute?.("onclick")) score += 16;
      if (area >= 24000) score += 10;
      if (area >= 90000) score += 10;
      if (distance < 140) score += 16;
      else if (distance < 260) score += 10;
      if (rect.left <= centerX && rect.right >= centerX && rect.top <= centerY && rect.bottom >= centerY) score += 18;
      if (Number(window.getComputedStyle(node).zIndex || "0") >= 10) score += 4;
      if (sourceSwitch && tag !== "video") score -= 70;

      return {
        score,
        kind,
        tag,
        text,
        selector_hint: node.id
          ? `#${node.id}`
          : node.getAttribute?.("name")
            ? `[name="${node.getAttribute("name")}"]`
            : className
              ? `.${className.trim().split(/\s+/).slice(0, 2).join(".")}`
              : tag,
        geometry: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          center_x: Math.round(nodeCenterX),
          center_y: Math.round(nodeCenterY),
        },
        node,
      };
    };

    const videos = Array.from(document.querySelectorAll("video"))
      .filter(visible)
      .map((video) => {
        const rect = video.getBoundingClientRect();
        return {
          tag: "video",
          text: normalize(video.currentSrc || video.src || "video"),
          score: 140 + (video.readyState >= 2 ? 20 : 0),
          geometry: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            center_x: Math.round(rect.x + rect.width / 2),
            center_y: Math.round(rect.y + rect.height / 2),
          },
          paused: Boolean(video.paused),
          ready_state: Number(video.readyState || 0),
          current_time: Number(video.currentTime || 0),
        };
      });

    const controls = Array.from(
      document.querySelectorAll(
        "button,a,[role='button'],[onclick],video,.vjs-big-play-button,.jw-icon-playback,.plyr__control,[class*='play'],[class*='player'],[class*='overlay'],[class*='poster'],img,svg",
      ),
    )
      .filter(visible)
      .map(scoreNode)
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({
        score: entry.score,
        kind: entry.kind,
        tag: entry.tag,
        text: entry.text,
        selector_hint: entry.selector_hint,
        geometry: entry.geometry,
      }));

    return {
      frame_url: location.href,
      video_count: videos.length,
      playable_video_count: videos.filter((video) => video.ready_state >= 2 || video.current_time > 0).length,
      top_candidates: controls,
      videos: videos.slice(0, limit),
      player_shell_detected: Boolean(
        document.querySelector("video, iframe, .vjs-tech, .jw-video, .jwplayer, .plyr, [class*='player'], [class*='stream']"),
      ),
    };
  }, { candidateLimit }).catch(() => ({
    frame_url: frame.url(),
    video_count: 0,
    playable_video_count: 0,
    top_candidates: [],
    videos: [],
    player_shell_detected: false,
  }));
}

async function findBestPlaybackFrame(frame, { candidateLimit = 6 } = {}) {
  const queue = [{ frame, depth: 0 }];
  let best = null;

  while (queue.length) {
    const current = queue.shift();
    if (!current) break;
    const summary = await inspectFrameForPlayback(current.frame, { candidateLimit });
    const score =
      summary.video_count * 60
      + summary.playable_video_count * 25
      + summary.top_candidates.length * 6
      + (summary.player_shell_detected ? 18 : 0)
      - current.depth * 4;

    if (!best || score > best.score) {
      best = { frame: current.frame, score, summary, depth: current.depth };
    }

    for (const child of current.frame.childFrames()) {
      queue.push({ frame: child, depth: current.depth + 1 });
    }
  }

  return best;
}

export async function runPlaybackPreflight(frame, runtime = getMediaRuntimeConfig(), { clickBlockers = true } = {}) {
  return frame.evaluate(({ actionLimit, blockerPattern, shouldClick }) => {
    const normalize = (value, max = 160) =>
      String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
    const blockerActionRe = new RegExp(blockerPattern, "i");
    const visible = (node) => {
      if (!(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style) return false;
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
      if (Number(style.opacity || "1") === 0) return false;
      return true;
    };
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;

    const overlayLike = Array.from(document.querySelectorAll("div,section,aside,dialog,iframe"))
      .filter(visible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const text = normalize(
          node.innerText
          || node.getAttribute?.("aria-label")
          || node.getAttribute?.("title")
          || "",
        );
        const className = String(node.className || "").toLowerCase();
        const role = String(node.getAttribute?.("role") || "").toLowerCase();
        const area = rect.width * rect.height;
        const coversCenter = rect.left <= centerX && rect.right >= centerX && rect.top <= centerY && rect.bottom >= centerY;
        const blockingHints = /(cookie|consent|modal|dialog|overlay|popup|banner|ad|close|dismiss|accept|agree|allow|continue|skip)/.test(
          `${text} ${className} ${role}`,
        );
        return {
          node,
          text,
          className,
          covers_center: coversCenter,
          likely_blocker: coversCenter && (blockingHints || area >= (window.innerWidth * window.innerHeight * 0.14)),
          geometry: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .filter((entry) => entry.likely_blocker)
      .slice(0, 10);

    const actionNodes = Array.from(
      document.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit'],label,[onclick],span,div"),
    )
      .filter(visible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const text = normalize(
          node.innerText
          || node.textContent
          || node.getAttribute?.("aria-label")
          || node.getAttribute?.("title")
          || node.getAttribute?.("value")
          || "",
        );
        const haystack = `${text} ${node.className || ""} ${node.getAttribute?.("role") || ""}`.toLowerCase();
        const nearCenter = rect.left <= centerX && rect.right >= centerX && rect.top <= centerY && rect.bottom >= centerY;
        const blockerAction = blockerActionRe.test(haystack);
        let score = 0;
        if (!blockerAction) return { node, text, score };
        score += 32;
        if (/(close|dismiss|accept|agree|allow|skip|ok|got it|×|✕|\bx\b)/.test(haystack)) score += 28;
        if (nearCenter) score += 18;
        if (rect.width * rect.height >= 12000) score += 8;
        if (overlayLike.some((overlay) => {
          const ox = overlay.geometry.x;
          const oy = overlay.geometry.y;
          return rect.left >= ox && rect.top >= oy;
        })) score += 12;
        return { node, text, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    const actions = [];
    for (const candidate of shouldClick ? actionNodes.slice(0, actionLimit) : []) {
      try {
        candidate.node.click();
        actions.push(candidate.text || candidate.node.tagName.toLowerCase());
      } catch {
        // ignore
      }
    }

    return {
      overlays_detected: overlayLike.length,
      overlays: overlayLike.map((entry) => ({
        text: entry.text,
        ...entry.geometry,
        covers_center: entry.covers_center,
      })),
      actions,
      clicked: actions.length > 0,
    };
  }, {
    actionLimit: runtime.preflight_action_limit,
    blockerPattern: BLOCKER_ACTION_PATTERN.source,
    shouldClick: Boolean(clickBlockers),
  }).catch(() => ({
    overlays_detected: 0,
    overlays: [],
    actions: [],
    clicked: false,
  }));
}

export async function primeMediaProbe(frame, { mute = false } = {}) {
  return frame.evaluate((shouldMute) => {
    const stateKey = "__owc_media_probe__";
    const state = globalThis[stateKey] || {
      events: [],
      media_error_code: null,
      media_error_message: "",
    };
    globalThis[stateKey] = state;
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length) {
      state.video_count = 0;
      return { has_video: false, video_count: 0 };
    }

    const push = (name, index) => {
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.push(`${name}:${index}`);
      state.events = state.events.slice(-40);
    };

    videos.forEach((video, index) => {
      if (!video.__owcMediaProbeAttached) {
        Object.defineProperty(video, "__owcMediaProbeAttached", { value: true, configurable: true });
        ["play", "playing", "pause", "waiting", "stalled", "loadedmetadata", "canplay", "timeupdate"].forEach((eventName) => {
          video.addEventListener(eventName, () => push(eventName, index), { passive: true });
        });
        video.addEventListener("error", () => {
          push("error", index);
          state.media_error_code = video.error?.code ?? null;
          state.media_error_message = video.error?.message || "";
        }, { passive: true });
      }
      if (shouldMute) {
        video.muted = true;
      }
    });

    state.video_count = videos.length;
    return {
      has_video: true,
      video_count: videos.length,
      paused_count: videos.filter((video) => video.paused).length,
      ready_videos: videos.filter((video) => Number(video.readyState || 0) >= 2).length,
      current_time_max: Math.max(...videos.map((video) => Number(video.currentTime || 0)), 0),
    };
  }, mute).catch(() => ({ has_video: false, video_count: 0 }));
}

export async function readMediaProbe(frame) {
  return frame.evaluate(() => {
    const state = globalThis.__owc_media_probe__ || {};
    const videos = Array.from(document.querySelectorAll("video"));
    const normalizedEvents = Array.isArray(state.events) ? [...state.events] : [];
    return {
      has_video: videos.length > 0,
      video_count: videos.length,
      playing_videos: videos.filter((video) => !video.paused).length,
      ready_videos: videos.filter((video) => Number(video.readyState || 0) >= 2).length,
      max_ready_state: Math.max(...videos.map((video) => Number(video.readyState || 0)), 0),
      max_current_time: Math.max(...videos.map((video) => Number(video.currentTime || 0)), 0),
      events: normalizedEvents,
      media_error_code: state.media_error_code ?? null,
      media_error_message: state.media_error_message || "",
    };
  }).catch(() => ({
    has_video: false,
    video_count: 0,
    playing_videos: 0,
    ready_videos: 0,
    max_ready_state: 0,
    max_current_time: 0,
    events: [],
    media_error_code: null,
    media_error_message: "",
  }));
}

function interpretVerificationSignal(probe = {}) {
  const events = Array.isArray(probe.events) ? probe.events.map((item) => String(item).toLowerCase()) : [];
  if (events.some((item) => item.startsWith("timeupdate:"))) return "timeupdate";
  if (events.some((item) => item.startsWith("playing:"))) return "playing";
  if (events.some((item) => item.startsWith("canplay:"))) return "canplay";
  if (Number(probe.max_current_time || 0) > 0.25) return "current_time_advanced";
  if (Number(probe.max_ready_state || 0) >= 2 && Number(probe.playing_videos || 0) > 0) return "ready_and_unpaused";
  return "";
}

export function mediaProbeShowsPlayback(probe = {}) {
  return Boolean(interpretVerificationSignal(probe));
}

export async function waitForPlayback(frame, timeoutMs) {
  const startedAt = Date.now();
  let probe = await readMediaProbe(frame);
  while ((Date.now() - startedAt) < timeoutMs) {
    const signal = interpretVerificationSignal(probe);
    if (signal) {
      return { started: true, probe, signal };
    }
    await wait(200);
    probe = await readMediaProbe(frame);
  }
  const signal = interpretVerificationSignal(probe);
  return { started: Boolean(signal), probe, signal };
}

/**
 * Direct play invocation used by action-tools.play_media: click the resolved
 * handle (if any), then call video.play() on the first video in the frame.
 * Moved here from action-tools.js local copy during the [TOOL-DUP] dedupe so
 * both engines share one implementation.
 */
export async function invokeMediaPlayback(frame, handle, { mute = false } = {}) {
  let clickSuccessful = false;
  let clickError = null;

  if (handle) {
    try {
      await handle.click();
      clickSuccessful = true;
    } catch (error) {
      clickError = error?.message || String(error);
    }
  }

  const playResult = await frame.evaluate(async ({ shouldMute, allowDeferred }) => {
    const video = document.querySelector('video');
    if (!video) {
      return {
        ok: Boolean(allowDeferred),
        deferred: Boolean(allowDeferred),
        error: allowDeferred ? '' : 'No video element found',
      };
    }
    if (shouldMute) {
      video.muted = true;
    }
    try {
      const result = video.play?.();
      if (result && typeof result.then === 'function') {
        await result;
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || String(error),
        name: error?.name || 'Error',
      };
    }
  }, { shouldMute: mute, allowDeferred: clickSuccessful }).catch((error) => ({
    ok: false,
    error: error?.message || String(error),
    name: error?.name || 'Error',
  }));

  return {
    click_successful: clickSuccessful,
    click_error: clickError,
    play_result: playResult,
  };
}

async function clickPreferredHandle(handle) {
  if (!handle) return { ok: false, strategy: "preferred_handle_click", error: "No handle" };
  try {
    await handle.click();
    return { ok: true, strategy: "preferred_handle_click" };
  } catch (error) {
    return { ok: false, strategy: "preferred_handle_click", error: error?.message || String(error) };
  }
}

async function clickPreferredCoordinates(page, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return { ok: false, strategy: "coordinate_fallback", error: "No coordinate fallback available" };
  }
  try {
    await clickCoordinates(page, point.x, point.y);
    return { ok: true, strategy: "coordinate_fallback", point };
  } catch (error) {
    return { ok: false, strategy: "coordinate_fallback", error: error?.message || String(error), point };
  }
}

async function activateCandidatesInFrame(
  frame,
  runtime,
  { mute = false, allowCandidateClick = true, allowVideoPlay = true } = {},
) {
  return frame.evaluate(({ candidateLimit, muted, playPattern, sourceSwitchPattern, clickCandidates, playVideos }) => {
    const normalize = (value, max = 140) =>
      String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
    const playActionRe = new RegExp(playPattern, "i");
    const sourceSwitchRe = new RegExp(sourceSwitchPattern, "i");
    const visible = (node) => {
      if (!(node instanceof Element)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (!style) return false;
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
      if (Number(style.opacity || "1") === 0) return false;
      return true;
    };
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const controls = Array.from(
      document.querySelectorAll(
        "button,a,[role='button'],[onclick],video,.vjs-big-play-button,.jw-icon-playback,.plyr__control,[class*='play'],[class*='player'],[class*='overlay'],[class*='poster'],img,svg",
      ),
    )
      .filter(visible)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const text = normalize(
          node.innerText
          || node.textContent
          || node.getAttribute?.("aria-label")
          || node.getAttribute?.("title")
          || node.getAttribute?.("value")
          || "",
        );
        const className = String(node.className || "").toLowerCase();
        const role = String(node.getAttribute?.("role") || "").toLowerCase();
        const tag = String(node.tagName || "").toLowerCase();
        const attrs = `${text} ${className} ${role}`.toLowerCase();
        const explicitPlay = playActionRe.test(attrs);
        const sourceSwitch = sourceSwitchRe.test(attrs) && !explicitPlay;
        const nodeCenterX = rect.left + rect.width / 2;
        const nodeCenterY = rect.top + rect.height / 2;
        const distance = Math.hypot(centerX - nodeCenterX, centerY - nodeCenterY);
        let score = 0;
        if (tag === "video") score += 90;
        if (explicitPlay) score += 50;
        if (/(player|poster|overlay|control|video-js|jwplayer|plyr)/.test(attrs)) score += 22;
        if (rect.left <= centerX && rect.right >= centerX && rect.top <= centerY && rect.bottom >= centerY) score += 18;
        if (distance < 180) score += 14;
        if (tag === "button" || role === "button" || tag === "a" || node.getAttribute?.("onclick")) score += 10;
        if (rect.width * rect.height >= 18000) score += 8;
        if (sourceSwitch && tag !== "video") score -= 75;
        return { node, score, text, tag, sourceSwitch };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateLimit);

    const clicked = [];
    for (const candidate of (clickCandidates ? controls.slice(0, 1) : [])) {
      try {
        candidate.node.click();
        clicked.push({
          strategy: clicked.length === 0 ? "candidate_click" : "candidate_follow_up",
          text: candidate.text,
          tag: candidate.tag,
          score: candidate.score,
          source_switch_suppressed: Boolean(candidate.sourceSwitch),
        });
      } catch {
        // ignore
      }
    }

    const playCalls = [];
    const videos = Array.from(document.querySelectorAll("video")).filter(visible);
    if (playVideos) videos.forEach((video, index) => {
      try {
        if (muted) {
          video.muted = true;
        }
        const result = video.play?.();
        if (result && typeof result.catch === "function") {
          result.catch(() => {});
        }
        playCalls.push({
          strategy: muted ? "muted_video_play" : "video_play",
          index,
          src: normalize(video.currentSrc || video.src || "video"),
        });
      } catch {
        // ignore
      }
    });

    return {
      clicked,
      play_calls: playCalls,
      candidate_summary: controls.map((candidate) => ({
        text: candidate.text,
        tag: candidate.tag,
        score: candidate.score,
      })),
    };
  }, {
    candidateLimit: runtime.candidate_limit,
    muted: Boolean(mute),
    playPattern: PLAY_ACTION_PATTERN.source,
    sourceSwitchPattern: SOURCE_SWITCH_PATTERN.source,
    clickCandidates: Boolean(allowCandidateClick),
    playVideos: Boolean(allowVideoPlay),
  }).catch(() => ({
    clicked: [],
    play_calls: [],
    candidate_summary: [],
  }));
}

function candidateReason(candidate = {}) {
  const haystack = `${candidate.kind || ""} ${candidate.tag || ""} ${candidate.text || ""} ${candidate.selector_hint || ""}`.toLowerCase();
  if (candidate.kind === "video" || candidate.tag === "video") return "visible video element";
  if (/play|watch|start|resume|unmute|go live/.test(haystack)) return "explicit play-like control";
  if (/player|poster|overlay|control|video-js|jwplayer|plyr/.test(haystack)) return "player surface or overlay";
  return "candidate from player/media region";
}

export async function inspectPlaybackActivationCandidates({
  frame,
  framePath = "root",
  browserId = "playwright",
} = {}) {
  const runtime = getMediaRuntimeConfig(browserId);
  const resolvedSummary = await inspectFrameForPlayback(frame, { candidateLimit: runtime.candidate_limit });
  let activeFrame = frame;
  let activeFramePath = framePath;
  let frameRelocated = false;

  if (!resolvedSummary.video_count && !resolvedSummary.top_candidates.length) {
    const bestFrame = await findBestPlaybackFrame(frame, { candidateLimit: runtime.candidate_limit });
    if (bestFrame && bestFrame.frame && bestFrame.frame !== frame && bestFrame.score > 0) {
      activeFrame = bestFrame.frame;
      activeFramePath = deriveFramePath(bestFrame.frame);
      frameRelocated = true;
    }
  }

  const summary = activeFrame === frame
    ? resolvedSummary
    : await inspectFrameForPlayback(activeFrame, { candidateLimit: runtime.candidate_limit });
  const videoCandidates = (summary.videos || []).map((video, index) => ({
    kind: "video",
    text: video.text || "video",
    frame_path: activeFramePath,
    geometry: video.geometry || null,
    paused: Boolean(video.paused),
    ready_state: Number(video.ready_state || 0),
    activation_reason: "visible video element",
    requires_agent_choice: true,
    index,
  }));
  const controlCandidates = (summary.top_candidates || []).map((candidate, index) => ({
    kind: candidate.kind || candidate.tag || "control",
    tag: candidate.tag || "",
    text: candidate.text || "",
    selector_hint: candidate.selector_hint || "",
    frame_path: activeFramePath,
    geometry: candidate.geometry || null,
    score: Number(candidate.score || 0),
    activation_reason: candidateReason(candidate),
    requires_agent_choice: true,
    index: videoCandidates.length + index,
  }));

  return {
    runtime,
    frame_path: activeFramePath,
    frame_url: activeFrame.url(),
    frame_relocated: frameRelocated,
    candidate_summary: summary,
    activation_candidates: [...videoCandidates, ...controlCandidates].slice(0, runtime.candidate_limit),
    needs_agent_choice: true,
  };
}

export async function activatePlayback({
  page,
  frame,
  handle = null,
  framePath = "root",
  waitMs = 1500,
  browserId = "playwright",
  preferredCoordinates = null,
  allowCandidateClick = true,
  allowPreflightClick = true,
} = {}) {
  const runtime = getMediaRuntimeConfig(browserId);
  const resolvedSummary = await inspectFrameForPlayback(frame, { candidateLimit: runtime.candidate_limit });
  let activeFrame = frame;
  let activeFramePath = framePath;
  let frameRelocated = false;

  if (!resolvedSummary.video_count && !resolvedSummary.top_candidates.length) {
    const bestFrame = await findBestPlaybackFrame(frame, { candidateLimit: runtime.candidate_limit });
    if (bestFrame && bestFrame.frame && bestFrame.frame !== frame && bestFrame.score > 0) {
      activeFrame = bestFrame.frame;
      activeFramePath = deriveFramePath(bestFrame.frame);
      frameRelocated = true;
    }
  }

  const candidateSummary = await inspectFrameForPlayback(activeFrame, { candidateLimit: runtime.candidate_limit });
  const preflight = await runPlaybackPreflight(activeFrame, runtime, { clickBlockers: allowPreflightClick });
  if (preflight.clicked) {
    await wait(runtime.settle_after_action_ms);
  }

  const strategies_attempted = [];
  let playbackStarted = false;
  let verificationSignal = "";
  let finalProbe = await readMediaProbe(activeFrame);
  let finalError = "";
  let mediaConfirmed = false;
  let handleBox = null;
  if (handle && typeof handle.boundingBox === "function") {
    handleBox = await handle.boundingBox().catch(() => null);
  }
  const coordinatePoint = preferredCoordinates || buildCoordinatePoint(handleBox);

  for (let attemptIndex = 0; attemptIndex < runtime.total_attempts; attemptIndex += 1) {
    const muteForAttempt = attemptIndex >= 1;
    await primeMediaProbe(activeFrame, { mute: muteForAttempt });
    const stepResults = [];

    if (attemptIndex === 0 && handle) {
      stepResults.push(await clickPreferredHandle(handle));
    }

    const inFrameActivation = await activateCandidatesInFrame(activeFrame, runtime, {
      mute: muteForAttempt,
      allowCandidateClick,
      allowVideoPlay: true,
    });
    stepResults.push(
      ...inFrameActivation.clicked,
      ...inFrameActivation.play_calls,
    );

    if (!stepResults.length && coordinatePoint) {
      stepResults.push(await clickPreferredCoordinates(page, coordinatePoint));
    }

    strategies_attempted.push({
      attempt: attemptIndex + 1,
      muted_retry: muteForAttempt,
      steps: stepResults,
      candidate_summary: inFrameActivation.candidate_summary,
    });

    await wait(Math.min(waitMs, runtime.settle_after_action_ms));
    const verification = runtime.verify_playback
      ? await waitForPlayback(activeFrame, runtime.verification_timeout_ms)
      : { started: true, probe: await readMediaProbe(activeFrame), signal: "" };
    finalProbe = verification.probe || await readMediaProbe(activeFrame);
    verificationSignal = verification.signal || interpretVerificationSignal(finalProbe);
    playbackStarted = Boolean(verification.started || verificationSignal);
    mediaConfirmed = playbackStarted;

    if (playbackStarted) {
      finalError = "";
      break;
    }

    finalError = finalProbe.media_error_message || "Playback did not start";
    const backoffMs = runtime.retry_backoff_ms[attemptIndex]
      ?? runtime.retry_backoff_ms[runtime.retry_backoff_ms.length - 1]
      ?? 0;
    if (attemptIndex < runtime.total_attempts - 1 && backoffMs > 0) {
      await wait(backoffMs);
    }
  }

  return {
    runtime,
    preflight,
    candidate_summary: candidateSummary,
    strategies_attempted,
    frame_path: activeFramePath,
    frame_url: activeFrame.url(),
    frame_relocated: frameRelocated,
    playback_started: playbackStarted,
    media_confirmed: mediaConfirmed,
    verification_signal: verificationSignal || "",
    playback_probe: finalProbe,
    final_error: playbackStarted ? "" : finalError,
  };
}
