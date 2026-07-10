import crypto from "node:crypto";

import {
  closeEphemeralBrowser,
  connectBrowser,
  getPage,
  setActivePage,
} from "./browser.js";
import { screenshotFull, screenshotViewport } from "./screenshot.js";
import { uploadImage } from "./upload.js";
import {
  classifyPopupCandidate,
  isBlankPopupUrl,
  selectPopupCandidate,
} from "../../shared/popup-selection.js";

function hashValue(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex");
}

const CHALLENGE_PATTERNS = [
  /cf-challenge/,
  /challenge-platform/,
  /cdn-cgi\/challenge/,
  /just a moment/,
  /checking your browser/,
  /verify you are human/,
  /security check/,
  /captcha/,
  /attention required/,
];

const PROVIDER_PATTERNS = {
  cloudflare: [/cloudflare/, /cf-ray/, /cf_chl_/, /cdn-cgi/],
  generic_challenge: [/captcha/, /verify you are human/, /security check/],
};

const BLOCK_PATTERNS = [
  /access denied/,
  /forbidden/,
  /temporarily unavailable/,
  /request blocked/,
  /unusual traffic/,
  /rate limit/,
  /blocked/,
];

function safeUrlOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function decodeUriStringSafe(value) {
  const text = String(value ?? "");
  if (!text || text.startsWith("data:")) return text;
  if (!/%[0-9a-fA-F]{2}/.test(text) && !text.includes("+")) return text;

  const candidates = text.includes("+")
    ? [text.replace(/\+/g, "%20"), text]
    : [text];
  for (const candidate of candidates) {
    for (const decoder of [decodeURI, decodeURIComponent]) {
      try {
        const decoded = decoder(candidate);
        if (decoded) return decoded;
      } catch {
        // keep trying
      }
    }
  }
  return text;
}

export function decodeUriEverywhere(value, seen = new WeakSet()) {
  if (typeof value === "string") return decodeUriStringSafe(value);
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return value;

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => decodeUriEverywhere(item, seen));
  }

  const decoded = {};
  for (const [key, nested] of Object.entries(value)) {
    decoded[key] = decodeUriEverywhere(nested, seen);
  }
  return decoded;
}

function encodeElementRef(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeElementRef(elementRef) {
  return JSON.parse(Buffer.from(elementRef, "base64url").toString("utf8"));
}

export function summarizePurpose(url, name = "", width = 0, height = 0) {
  const haystack = `${url} ${name}`.toLowerCase();
  if (/captcha|cloudflare|verify|challenge/.test(haystack)) return "challenge";
  if (/ad|banner|doubleclick|googlesyndication|popunder|track/.test(haystack))
    return "ad";
  if (/embed|player|stream|video/.test(haystack)) return "player";
  if (width >= 300 && height >= 180) return "content";
  return "unknown";
}

export function detectAccessStateFromSignals({
  title = "",
  textSample = "",
  htmlSample = "",
  url = "",
} = {}) {
  const haystack =
    `${title}\n${textSample}\n${htmlSample}\n${url}`.toLowerCase();
  const challengeReasons = [];
  let suspectedProvider = "";

  for (const pattern of CHALLENGE_PATTERNS) {
    if (pattern.test(haystack)) {
      challengeReasons.push(pattern.source);
    }
  }

  const hasCloudflareMarker = PROVIDER_PATTERNS.cloudflare.some((pattern) =>
    pattern.test(haystack),
  );
  const hasGenericChallengeMarker = PROVIDER_PATTERNS.generic_challenge.some(
    (pattern) => pattern.test(haystack),
  );

  const challengeDetected = challengeReasons.length > 0;
  if (hasCloudflareMarker) {
    suspectedProvider = "cloudflare";
  } else if (hasGenericChallengeMarker) {
    suspectedProvider = "generic_challenge";
  }

  const blockReasons = [];
  for (const pattern of BLOCK_PATTERNS) {
    if (pattern.test(haystack)) {
      blockReasons.push(pattern.source);
    }
  }

  const blocked = challengeDetected || blockReasons.length > 0;
  const confidence = challengeDetected
    ? "high"
    : blockReasons.length > 0
      ? "medium"
      : "low";

  // Provider markers alone (e.g., analytics/CDN mentions) are not enough to mark a page blocked.
  const reasons = blocked
    ? [...new Set([...challengeReasons, ...blockReasons])]
    : [];

  return {
    blocked,
    challenge_detected: challengeDetected,
    suspected_provider: blocked ? suspectedProvider || "none" : "none",
    confidence,
    reasons,
  };
}

async function collectFrameMetrics(frame) {
  try {
    return await frame.evaluate(() => {
      const body = document.body;
      const doc = document.documentElement;
      const text = (body?.innerText || "").replace(/\s+/g, " ").trim();
      return {
        title: document.title || "",
        readyState: document.readyState || "unknown",
        textSample: text.slice(0, 1200),
        textLength: text.length,
        htmlSample: (doc?.outerHTML || "").slice(0, 3000),
        linkCount: document.querySelectorAll("a[href]").length,
        buttonCount: document.querySelectorAll(
          'button,[role="button"],[role="tab"],[onclick]',
        ).length,
        inputCount: document.querySelectorAll("input,textarea,select").length,
        overlayCount: document.querySelectorAll(
          '[class*="overlay"],[class*="modal"],[class*="popup"]',
        ).length,
        videoCount: document.querySelectorAll("video").length,
        iframeCount: document.querySelectorAll("iframe").length,
      };
    });
  } catch (error) {
    return {
      title: "",
      readyState: "error",
      textSample: "",
      textLength: 0,
      htmlSample: "",
      linkCount: 0,
      buttonCount: 0,
      inputCount: 0,
      overlayCount: 0,
      videoCount: 0,
      iframeCount: 0,
      error: error.message,
    };
  }
}

async function describeFrame(frame, framePath, rootOrigin, index = 0) {
  const frameUrl = frame.url() || "";
  const metrics = await collectFrameMetrics(frame);
  let boundingBox = null;

  if (frame.parentFrame()) {
    try {
      const frameElement = await frame.frameElement();
      boundingBox = await frameElement.boundingBox();
      await frameElement.dispose();
    } catch {
      boundingBox = null;
    }
  }

  return {
    frame_path: framePath,
    url: frameUrl,
    name: frame.name() || "",
    title: metrics.title || "",
    parent_frame_path: frame.parentFrame()
      ? framePath.split(".").slice(0, -1).join(".") || "root"
      : null,
    child_count: frame.childFrames().length,
    index,
    accessible: !metrics.error,
    cross_origin: Boolean(
      rootOrigin &&
      frameUrl &&
      safeUrlOrigin(frameUrl) &&
      safeUrlOrigin(frameUrl) !== rootOrigin,
    ),
    candidate_purpose: summarizePurpose(
      frameUrl,
      frame.name() || "",
      Math.round(boundingBox?.width || 0),
      Math.round(boundingBox?.height || 0),
    ),
    dimensions: boundingBox
      ? {
          x: Math.round(boundingBox.x),
          y: Math.round(boundingBox.y),
          width: Math.round(boundingBox.width),
          height: Math.round(boundingBox.height),
        }
      : null,
    signals: {
      ready_state: metrics.readyState,
      text_length: metrics.textLength,
      links: metrics.linkCount,
      buttons: metrics.buttonCount,
      inputs: metrics.inputCount,
      overlays: metrics.overlayCount,
      videos: metrics.videoCount,
      iframes: metrics.iframeCount,
    },
  };
}

async function walkFrames(frame, framePath, rootOrigin, collector, index = 0) {
  collector.push(await describeFrame(frame, framePath, rootOrigin, index));
  const children = frame.childFrames();
  for (let index = 0; index < children.length; index += 1) {
    await walkFrames(
      children[index],
      `${framePath}.${index}`,
      rootOrigin,
      collector,
      index,
    );
  }
}

export async function buildFrameTree(page) {
  const frames = [];
  const rootOrigin = safeUrlOrigin(page.url());
  await walkFrames(page.mainFrame(), "root", rootOrigin, frames, 0);
  return frames;
}

export async function resolveFrame(page, framePath = "root") {
  if (!framePath || framePath === "root") {
    return { ok: true, frame: page.mainFrame(), frame_path: "root" };
  }

  const parts = String(framePath).split(".");
  if (parts[0] !== "root") {
    return { ok: false, error: `Invalid frame_path '${framePath}'` };
  }

  let frame = page.mainFrame();
  for (let index = 1; index < parts.length; index += 1) {
    const childIndex = Number.parseInt(parts[index], 10);
    if (!Number.isInteger(childIndex) || childIndex < 0) {
      return {
        ok: false,
        error: `Invalid frame_path segment '${parts[index]}'`,
      };
    }
    const children = frame.childFrames();
    if (childIndex >= children.length) {
      return { ok: false, error: `Frame path '${framePath}' does not exist` };
    }
    frame = children[childIndex];
  }

  return { ok: true, frame, frame_path: framePath };
}

export async function buildFrameState(page, framePath = "root") {
  const resolved = await resolveFrame(page, framePath);
  if (!resolved.ok) {
    return {
      ok: false,
      frame_path: framePath,
      dom_epoch: "",
      page_state_id: "",
      error: resolved.error,
    };
  }

  const frame = resolved.frame;
  const metrics = await collectFrameMetrics(frame);
  const domEpoch = hashValue(
    `${frame.url()}|${metrics.readyState}|${metrics.textSample}|${metrics.htmlSample}`,
  );
  const pageStateId = hashValue(`${page.url()}|${framePath}|${domEpoch}`);

  return {
    ok: true,
    frame,
    frame_path: framePath,
    dom_epoch: domEpoch,
    page_state_id: pageStateId,
    frame_metrics: metrics,
  };
}

function createXpath(node) {
  const parts = [];
  let current = node;
  while (current && current.nodeType === 1) {
    let idx = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) idx += 1;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
    current = current.parentElement;
  }
  return `//${parts.join("/")}`;
}

function createSelector(node) {
  if (node.id) return `#${node.id}`;
  if (node.getAttribute("name")) return `[name="${node.getAttribute("name")}"]`;
  const classes = (node.className || "")
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (classes.length > 0) return `.${classes.slice(0, 2).join(".")}`;
  return node.tagName.toLowerCase();
}

function inferKind(node) {
  const tag = node.tagName.toLowerCase();
  const type = (node.getAttribute("type") || "").toLowerCase();
  const role = (node.getAttribute("role") || "").toLowerCase();
  const classes = (node.className || "").toString().toLowerCase();

  if (tag === "iframe") return "iframe";
  if (tag === "video") return "video";
  if (tag === "form") return "form";
  if (tag === "select") return "select";
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (tag === "input" || tag === "textarea") return "input";
  if (role === "tab" || classes.includes("tab")) return "tab";
  if (
    classes.includes("overlay") ||
    classes.includes("modal") ||
    classes.includes("popup")
  )
    return "overlay";
  if (tag === "a" && node.getAttribute("href")) return "link";
  if (tag === "button" || role === "button" || node.getAttribute("onclick"))
    return "button";
  return "element";
}

export async function collectElements(frame, framePath = "root") {
  return frame.evaluate(
    ({ framePathValue }) => {
      const isVisible = (node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0"
        );
      };

      const nodes = Array.from(
        document.querySelectorAll(
          'a[href],button,input,textarea,select,video,iframe,form,[role="button"],[role="tab"],[onclick],[class*="tab"],[class*="overlay"],[class*="modal"],[class*="popup"]',
        ),
      );

      return nodes.map((node, index) => {
        const rect = node.getBoundingClientRect();
        const attrs = {};
        for (const attr of [
          "href",
          "src",
          "name",
          "placeholder",
          "type",
          "role",
          "value",
          "aria-label",
          "data-server",
          "data-source",
        ]) {
          const value = node.getAttribute(attr);
          if (value) attrs[attr] = value;
        }

        const text = (node.innerText || node.textContent || node.value || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        const kind = (() => {
          const tag = node.tagName.toLowerCase();
          const type = (node.getAttribute("type") || "").toLowerCase();
          const role = (node.getAttribute("role") || "").toLowerCase();
          const classes = (node.className || "").toString().toLowerCase();

          if (tag === "iframe") return "iframe";
          if (tag === "video") return "video";
          if (tag === "form") return "form";
          if (tag === "select") return "select";
          if (type === "checkbox") return "checkbox";
          if (type === "radio") return "radio";
          if (tag === "input" || tag === "textarea") return "input";
          if (role === "tab" || classes.includes("tab")) return "tab";
          if (
            classes.includes("overlay") ||
            classes.includes("modal") ||
            classes.includes("popup")
          )
            return "overlay";
          if (tag === "a" && node.getAttribute("href")) return "link";
          if (
            tag === "button" ||
            role === "button" ||
            node.getAttribute("onclick")
          )
            return "button";
          return "element";
        })();

        const xpath = (() => {
          const parts = [];
          let current = node;
          while (current && current.nodeType === 1) {
            let idx = 1;
            let sibling = current.previousElementSibling;
            while (sibling) {
              if (sibling.tagName === current.tagName) idx += 1;
              sibling = sibling.previousElementSibling;
            }
            parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
            current = current.parentElement;
          }
          return `//${parts.join("/")}`;
        })();

        const selector = (() => {
          if (node.id) return `#${node.id}`;
          const name = node.getAttribute("name");
          if (name) return `[name="${name}"]`;
          const classes = (node.className || "")
            .toString()
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          if (classes.length > 0) return `.${classes.slice(0, 2).join(".")}`;
          return `${node.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
        })();

        return {
          kind,
          tag: node.tagName.toLowerCase(),
          type: (node.getAttribute("type") || "").toLowerCase(),
          role: (node.getAttribute("role") || "").toLowerCase(),
          text,
          href: node.getAttribute("href") || "",
          src: node.getAttribute("src") || "",
          selector,
          xpath,
          attrs,
          visible: isVisible(node),
          checked: Boolean(node.checked),
          disabled: Boolean(node.disabled),
          selected: Boolean(node.selected),
          value: (node.value || "").slice(0, 200),
          frame_path: framePathValue,
          geometry: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            center_x: Math.round(rect.x + rect.width / 2),
            center_y: Math.round(rect.y + rect.height / 2),
          },
          nearby_text: (node.parentElement?.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 220),
        };
      });
    },
    { framePathValue: framePath },
  );
}

export function augmentElements(elements, pageState) {
  return elements.map((element) => ({
    ...element,
    page_state_id: pageState.page_state_id,
    dom_epoch: pageState.dom_epoch,
    element_ref: encodeElementRef({
      frame_path: pageState.frame_path,
      selector: element.selector,
      xpath: element.xpath,
      text: element.text,
      tag: element.tag,
      kind: element.kind,
      dom_epoch: pageState.dom_epoch,
      page_state_id: pageState.page_state_id,
    }),
  }));
}

export function filterElements(
  elements,
  {
    kind,
    text_contains = "",
    text_regex = "",
    href_contains = "",
    href_regex = "",
    attr = null,
    attr_name = "",
    attr_value_contains = "",
    attr_value_regex = "",
    visible_only = true,
    limit = 20,
  } = {},
) {
  const toRegex = (value) => {
    if (!value) return null;
    if (value instanceof RegExp) return value;
    try {
      return new RegExp(String(value), "i");
    } catch {
      return null;
    }
  };

  const normalizedText = String(text_contains || "").toLowerCase();
  const textRegex = toRegex(text_regex);
  const normalizedHref = String(href_contains || "").toLowerCase();
  const hrefRegex = toRegex(href_regex);
  const attrName = attr?.name ? String(attr.name) : String(attr_name || "");
  const attrValue = attr?.value_contains
    ? String(attr.value_contains).toLowerCase()
    : String(attr_value_contains || "").toLowerCase();
  const attrValueRegex = toRegex(attr?.value_regex || attr_value_regex);

  return elements
    .filter((element) => !kind || element.kind === kind)
    .filter((element) => !visible_only || element.visible)
    .filter(
      (element) =>
        !normalizedText || element.text.toLowerCase().includes(normalizedText),
    )
    .filter(
      (element) => !textRegex || textRegex.test(String(element.text || "")),
    )
    .filter(
      (element) =>
        !normalizedHref || element.href.toLowerCase().includes(normalizedHref),
    )
    .filter(
      (element) => !hrefRegex || hrefRegex.test(String(element.href || "")),
    )
    .filter((element) => {
      if (!attrName) return true;
      const value = element.attrs?.[attrName] || "";
      const valueStr = String(value);
      const containsOk =
        !attrValue || valueStr.toLowerCase().includes(attrValue);
      const regexOk = !attrValueRegex || attrValueRegex.test(valueStr);
      return containsOk && regexOk;
    })
    .slice(0, limit);
}

async function resolveByText(frame, text) {
  const handle = await frame.evaluateHandle((needle) => {
    const normalizedNeedle = needle.toLowerCase();
    const nodes = Array.from(
      document.querySelectorAll(
        'a[href],button,input,textarea,select,[role="button"],[role="tab"],[onclick],label',
      ),
    );
    for (const node of nodes) {
      const candidate = (node.innerText || node.textContent || node.value || "")
        .replace(/\s+/g, " ")
        .trim();
      if (candidate.toLowerCase().includes(normalizedNeedle)) {
        return node;
      }
    }
    return null;
  }, text);
  const elementHandle = handle.asElement();
  if (!elementHandle) {
    await handle.dispose().catch(() => {});
  }
  return elementHandle;
}

function deriveFramePath(frame) {
  if (!frame.parentFrame()) return "root";

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

async function tryResolveLocatorInFrame(frame, locator, timeoutMs = 8000) {
  const attempts = [];

  if (locator.selector) {
    try {
      const handle = await frame.waitForSelector(locator.selector, {
        timeout: timeoutMs,
      });
      if (handle) {
        return {
          handle,
          locator_used: { selector: locator.selector },
          attempts,
        };
      }
    } catch (error) {
      attempts.push({
        strategy: "selector",
        locator: locator.selector,
        error: error.message,
      });
    }
  }

  if (locator.xpath) {
    try {
      const playwrightXpathSelector = `::-p-xpath(${locator.xpath})`;
      await frame.waitForSelector(playwrightXpathSelector, {
        timeout: timeoutMs,
      });
      const matches = await frame.$$(playwrightXpathSelector);
      const handle = matches[0] || null;
      if (handle) {
        return {
          handle,
          locator_used: { xpath: locator.xpath },
          attempts,
        };
      }
    } catch (error) {
      attempts.push({
        strategy: "xpath",
        locator: locator.xpath,
        error: error.message,
      });
    }
  }

  if (locator.text) {
    try {
      await frame
        .waitForFunction(
          (needle) =>
            (document.body?.innerText || "")
              .toLowerCase()
              .includes(String(needle).toLowerCase()),
          { timeout: Math.min(timeoutMs, 2500) },
          locator.text,
        )
        .catch(() => {});

      const handle = await resolveByText(frame, locator.text);
      if (handle) {
        return {
          handle,
          locator_used: { text: locator.text },
          attempts,
        };
      }
    } catch (error) {
      attempts.push({
        strategy: "text",
        locator: locator.text,
        error: error.message,
      });
    }
  }

  return {
    handle: null,
    locator_used: {},
    attempts,
  };
}

export async function resolveElementTarget(
  page,
  {
    frame_path = "root",
    element_ref = "",
    selector = "",
    xpath = "",
    text = "",
  } = {},
) {
  let effectiveFramePath = frame_path || "root";
  let locator = { selector, xpath, text };
  let staleRefDetected = false;
  let frameFallbackApplied = false;
  let frameRelocated = false;
  let resolutionAttempts = [];

  if (element_ref) {
    let decoded;
    try {
      decoded = decodeElementRef(element_ref);
    } catch {
      return {
        ok: false,
        code: "invalid_element_ref",
        error: "Could not decode element_ref",
      };
    }

    effectiveFramePath = decoded.frame_path || effectiveFramePath;
    locator = {
      selector: decoded.selector || selector,
      xpath: decoded.xpath || xpath,
      text: decoded.text || text,
    };

    const currentState = await buildFrameState(page, effectiveFramePath);
    if (
      currentState.ok &&
      decoded.dom_epoch &&
      decoded.dom_epoch !== currentState.dom_epoch
    ) {
      staleRefDetected = true;
    }
  }

  if (!locator.selector && !locator.xpath && !locator.text) {
    return {
      ok: false,
      code: "missing_locator",
      error:
        "No locator was provided (element_ref, selector, xpath, or text is required).",
      frame_path: effectiveFramePath,
    };
  }

  let frameState = await buildFrameState(page, effectiveFramePath);
  if (!frameState.ok && effectiveFramePath !== "root") {
    const rootState = await buildFrameState(page, "root");
    if (rootState.ok) {
      frameState = rootState;
      effectiveFramePath = "root";
      frameFallbackApplied = true;
    }
  }

  if (!frameState.ok) {
    return { ok: false, code: "frame_not_found", error: frameState.error };
  }

  let resolvedFrame = frameState.frame;
  let resolvedFramePath = effectiveFramePath;
  let locatorUsed = {};

  const primaryResolution = await tryResolveLocatorInFrame(
    frameState.frame,
    locator,
    8000,
  );
  resolutionAttempts = resolutionAttempts.concat(
    (primaryResolution.attempts || []).map((attempt) => ({
      frame_path: effectiveFramePath,
      ...attempt,
    })),
  );

  let handle = primaryResolution.handle;
  locatorUsed = primaryResolution.locator_used || {};

  if (!handle) {
    const fallbackFrames = page
      .frames()
      .filter((candidate) => candidate !== frameState.frame)
      .slice(0, 20);

    for (const fallbackFrame of fallbackFrames) {
      const fallbackFramePath = deriveFramePath(fallbackFrame);
      const attempt = await tryResolveLocatorInFrame(
        fallbackFrame,
        locator,
        2000,
      );
      resolutionAttempts = resolutionAttempts.concat(
        (attempt.attempts || []).map((item) => ({
          frame_path: fallbackFramePath,
          ...item,
        })),
      );
      if (attempt.handle) {
        handle = attempt.handle;
        locatorUsed = attempt.locator_used || {};
        resolvedFrame = fallbackFrame;
        resolvedFramePath = fallbackFramePath;
        frameRelocated = fallbackFramePath !== effectiveFramePath;
        break;
      }
    }
  }

  if (!handle) {
    return {
      ok: false,
      code: staleRefDetected ? "stale_ref_not_found" : "element_not_found",
      error: "Could not resolve an element from the provided locator",
      frame_path: effectiveFramePath,
      page_state_id: frameState.page_state_id,
      dom_epoch: frameState.dom_epoch,
      stale_ref_detected: staleRefDetected,
      frame_fallback_applied: frameFallbackApplied,
      resolution_attempts: resolutionAttempts.slice(0, 20),
    };
  }

  return {
    ok: true,
    frame: resolvedFrame,
    frame_path: resolvedFramePath,
    handle,
    locator_used: locatorUsed,
    page_state_id: frameState.page_state_id,
    dom_epoch: frameState.dom_epoch,
    stale_ref_detected: staleRefDetected,
    frame_fallback_applied: frameFallbackApplied,
    frame_relocated: frameRelocated,
    resolution_attempts: resolutionAttempts.slice(0, 20),
  };
}

export async function captureScreenshot(
  page,
  { handle = null, mode = "viewport", fallbackFull = false } = {},
) {
  try {
    if (handle) {
      const buffer = await handle.screenshot({ type: "png" });
      const screenshotUrl = await uploadImage(
        `data:image/png;base64,${buffer.toString("base64")}`,
      );
      return {
        ok: true,
        screenshot_url: screenshotUrl,
        screenshot_mode: "element",
      };
    }

    if (mode === "full") {
      return {
        ok: true,
        screenshot_url: await screenshotFull(page),
        screenshot_mode: "full",
      };
    }

    return {
      ok: true,
      screenshot_url: await screenshotViewport(page),
      screenshot_mode: "viewport",
    };
  } catch (error) {
    if (handle && fallbackFull) {
      try {
        return {
          ok: true,
          screenshot_url: await screenshotViewport(page),
          screenshot_mode: "viewport",
        };
      } catch {
        // fall through
      }
    }

    return {
      ok: false,
      screenshot_url: "",
      screenshot_mode: mode,
      screenshot_error: error.message,
    };
  }
}

export function makeObservedChange(before, after, newTabUrls = [], popupTelemetry = {}) {
  return {
    navigated: before.url !== after.url,
    url_changed: before.url !== after.url,
    dom_changed: before.dom_epoch !== after.dom_epoch,
    popup_opened: newTabUrls.length > 0,
    new_tab_urls: newTabUrls,
    opened_targets: popupTelemetry.opened_targets || [],
    blocked_popup_attempts: popupTelemetry.blocked_popup_attempts || [],
    selected_target: popupTelemetry.selected_target || null,
    target_decision:
      popupTelemetry.target_decision ||
      (newTabUrls.length ? "no_adoptable_popup" : "no_popup"),
    active_page_url: popupTelemetry.active_page_url || after.url,
    opener_url: popupTelemetry.opener_url || before.url,
  };
}

export async function capturePageSnapshot(page, framePath = "root") {
  const state = await buildFrameState(page, framePath);
  return {
    url: page.url(),
    frame_path: framePath,
    dom_epoch: state.dom_epoch || "",
    page_state_id: state.page_state_id || "",
  };
}

export async function buildEnvelope(
  page,
  {
    frame_path = "root",
    title = "",
    ok = true,
    error = null,
    warnings = [],
    observed_change = null,
    screenshot = null,
    screenshotHandle = null,
    screenshotMode = "viewport",
    data = {},
  } = {},
) {
  const pageState = await buildFrameState(page, frame_path);
  const accessState = detectAccessStateFromSignals({
    title: await page.title().catch(() => ""),
    textSample: pageState.frame_metrics?.textSample || "",
    htmlSample: pageState.frame_metrics?.htmlSample || "",
    url: page.url(),
  });
  const screenshotResult =
    screenshot ||
    (await captureScreenshot(page, {
      handle: screenshotHandle,
      mode: screenshotMode,
      fallbackFull: true,
    }));

  const mergedWarnings = [...warnings];
  let finalOk = ok;
  let finalError = error;

  if (!screenshotResult.ok) {
    // Screenshot upload issues should not invalidate functional tool outcomes.
    // We keep the result usable and simply omit screenshot_url when capture fails.
  }

  return decodeUriEverywhere({
    ok: finalOk && pageState.ok,
    url: page.url(),
    title: title || (await page.title().catch(() => "")),
    frame_path,
    screenshot_url: screenshotResult.screenshot_url || "",
    page_state_id: pageState.page_state_id || "",
    dom_epoch: pageState.dom_epoch || "",
    error: pageState.ok ? finalError : pageState.error,
    warnings: mergedWarnings,
    observed_change,
    access_state: accessState,
    ...data,
  });
}

/**
 * Playwright: browserSession can be a { browser, context } object OR a WS endpoint string.
 * Tools pass the session object they received from launchEphemeralBrowser/connectBrowser.
 */
export async function withBrowserSession(
  browserSession,
  run,
  pageOptions = {},
) {
  let session = browserSession;
  let owned = false;

  if (typeof browserSession === "string") {
    // Legacy path: given a WS endpoint string, connect and own the session.
    session = await connectBrowser(browserSession || undefined);
    owned = true;
  }

  if (!session) {
    throw new Error(
      "Browser session is not available for this tool invocation.",
    );
  }

  try {
    const page = await getPage(session, pageOptions);
    return await run({
      browser: session.browser,
      context: session.context,
      page,
    });
  } finally {
    if (owned && session) {
      await closeEphemeralBrowser(session).catch(() => {});
    }
  }
}

/**
 * Playwright: track new tabs opened by the context.
 * Context emits 'page' events (not 'targetcreated') and passes the Page directly.
 */
async function readBlockedPopupAttempts(page, startedAt = 0) {
  if (!page || page.isClosed?.()) return [];
  return page
    .evaluate((since) => {
      const rows = Array.isArray(globalThis.__owc_popup_blocker_attempts__)
        ? globalThis.__owc_popup_blocker_attempts__
        : [];
      return rows
        .filter((row) => Number(row?.timestamp || 0) >= since)
        .slice(-30)
        .map((row, index) => ({
          index,
          url: String(row?.url || ""),
          target: String(row?.target || ""),
          features: String(row?.features || ""),
          timestamp: Number(row?.timestamp || 0),
          blocked: true,
          reason: String(row?.reason || "window_open_blocked"),
        }));
    }, startedAt)
    .catch(() => []);
}

function popupTargetTelemetry(candidate, openerUrl, selected = null, closeUnadopted = true) {
  const classification = classifyPopupCandidate(candidate, openerUrl);
  const isSelected = Boolean(selected && candidate === selected);
  const action = isSelected
    ? "adopted"
    : closeUnadopted
      ? "closed"
      : "ignored";
  const finalDecision = isSelected || closeUnadopted
    ? classification.target_decision
    : "left_open_unadopted";
  return {
    index: Number(candidate?.index || 0),
    initial_url: candidate?.initial_url || candidate?.initialUrl || "",
    final_url: candidate?.url || candidate?.final_url || candidate?.finalUrl || "",
    url: candidate?.url || candidate?.final_url || candidate?.finalUrl || "",
    title: candidate?.title || "",
    opener_url: openerUrl,
    classification: classification.classification,
    same_origin: Boolean(classification.same_origin),
    adoptable: Boolean(classification.adoptable),
    selected: isSelected,
    adopted: isSelected,
    action,
    target_decision: finalDecision,
    decision_reason: classification.reason,
    extracted_player_urls: classification.extracted_player_urls || [],
    closed: !isSelected && closeUnadopted,
  };
}

function blockedPopupTelemetry(attempt, openerUrl, index = 0) {
  const classification = classifyPopupCandidate(attempt, openerUrl);
  return {
    index,
    url: String(attempt?.url || ""),
    target: String(attempt?.target || ""),
    features: String(attempt?.features || ""),
    timestamp: Number(attempt?.timestamp || 0),
    blocked: true,
    reason: String(attempt?.reason || "window_open_blocked"),
    opener_url: openerUrl,
    classification: classification.classification,
    same_origin: Boolean(classification.same_origin),
    adoptable: false,
    action: "blocked",
    target_decision: classification.target_decision,
    decision_reason: classification.reason,
    extracted_player_urls: classification.extracted_player_urls || [],
  };
}

export function trackNewTabs(
  context,
  { openerPage = null, adopt = true, closeUnadopted = true } = {},
) {
  const newTabUrls = [];
  const candidates = [];
  const pending = new Set();
  const openerUrl = openerPage?.url?.() || "";
  const startedAt = Date.now();
  const tracker = {
    new_tab_urls: newTabUrls,
    opened_targets: [],
    blocked_popup_attempts: [],
    selected_target: null,
    target_decision: "no_popup",
    active_page_url: openerUrl,
    opener_url: openerUrl,
    async settle({ timeoutMs = 3000 } = {}) {
      const tasks = [...pending];
      if (tasks.length > 0) {
        await Promise.race([
          Promise.allSettled(tasks),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }

      for (const candidate of candidates) {
        if (!candidate.page?.isClosed?.()) {
          candidate.url = candidate.page.url();
          candidate.final_url = candidate.url;
          candidate.title = await candidate.page.title().catch(() => "");
          newTabUrls[candidate.index] = candidate.url;
        }
      }

      const selected = adopt
        ? selectPopupCandidate(candidates, openerUrl)
        : null;

      tracker.opened_targets.splice(
        0,
        tracker.opened_targets.length,
        ...candidates.map((candidate) =>
          popupTargetTelemetry(candidate, openerUrl, selected, closeUnadopted)),
      );

      const blockedAttempts = await readBlockedPopupAttempts(openerPage, startedAt);
      tracker.blocked_popup_attempts.splice(
        0,
        tracker.blocked_popup_attempts.length,
        ...blockedAttempts.map((attempt, index) =>
          blockedPopupTelemetry(attempt, openerUrl, index)),
      );

      if (closeUnadopted) {
        await Promise.allSettled(
          candidates
            .filter((candidate) => candidate !== selected)
            .map((candidate) => candidate.page?.close?.()),
        );
      }

      const resultPage = selected?.page && !selected.page.isClosed()
        ? selected.page
        : openerPage;
      tracker.selected_target = selected
        ? popupTargetTelemetry(selected, openerUrl, selected, closeUnadopted)
        : null;
      tracker.target_decision = tracker.selected_target
        ? tracker.selected_target.target_decision
        : tracker.blocked_popup_attempts.length
          ? "blocked_popup_attempts_only"
          : tracker.opened_targets.length
            ? "no_adoptable_popup"
            : "no_popup";
      tracker.active_page_url = resultPage?.url?.() || openerUrl;
      setActivePage(context, resultPage || openerPage);
      return resultPage || openerPage;
    },
    dispose: () => context.off("page", listener),
  };

  const recordPage = async (page) => {
    try {
      if (!page || page === openerPage) return;

      const initialUrl = page.url();
      const candidate = {
        index: candidates.length,
        page,
        initial_url: initialUrl,
        final_url: initialUrl,
        url: initialUrl,
        title: "",
        opener_url: openerUrl,
      };
      candidates.push(candidate);
      newTabUrls.push(candidate.url);

      if (isBlankPopupUrl(candidate.url)) {
        await page
          .waitForLoadState("domcontentloaded", { timeout: 2500 })
          .catch(() => {});
      }

      candidate.url = page.url();
      candidate.final_url = candidate.url;
      candidate.title = await page.title().catch(() => "");
      newTabUrls[candidate.index] = candidate.url;
    } catch {
      // ignore
    }
  };

  const listener = (page) => {
    const task = recordPage(page);
    pending.add(task);
    task.finally(() => pending.delete(task));
  };

  context.on("page", listener);
  return tracker;
}

export async function readElementDetail(page, params = {}) {
  const resolved = await resolveElementTarget(page, params);
  if (!resolved.ok) {
    return { ok: false, ...resolved };
  }

  const detail = await resolved.frame.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const attrs = {};
    for (const attr of node.getAttributeNames()) {
      attrs[attr] = node.getAttribute(attr);
    }

    const nearby = node.parentElement?.innerText || "";
    return {
      tag: node.tagName.toLowerCase(),
      text: (node.innerText || node.textContent || node.value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 400),
      html_preview: (node.outerHTML || "").slice(0, 1000),
      attrs,
      state: {
        checked: Boolean(node.checked),
        disabled: Boolean(node.disabled),
        selected: Boolean(node.selected),
        value: (node.value || "").slice(0, 300),
      },
      geometry: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        center_x: Math.round(rect.x + rect.width / 2),
        center_y: Math.round(rect.y + rect.height / 2),
      },
      nearby_text: nearby.replace(/\s+/g, " ").trim().slice(0, 400),
    };
  }, resolved.handle);

  const screenshot = await captureScreenshot(page, {
    handle: resolved.handle,
    fallbackFull: true,
  });
  await resolved.handle.dispose().catch(() => {});

  return {
    ok: true,
    frame_path: resolved.frame_path,
    page_state_id: resolved.page_state_id,
    dom_epoch: resolved.dom_epoch,
    locator_used: resolved.locator_used,
    stale_ref_detected: Boolean(resolved.stale_ref_detected),
    frame_fallback_applied: Boolean(resolved.frame_fallback_applied),
    frame_relocated: Boolean(resolved.frame_relocated),
    resolution_attempts: resolved.resolution_attempts || [],
    detail,
    screenshot,
  };
}

export async function getMediaSummary(frame) {
  try {
    return await frame.evaluate(() => {
      const videos = Array.from(document.querySelectorAll("video")).slice(0, 5);
      const libraries = {
        jwplayer: Boolean(window.jwplayer),
        videojs: Boolean(window.videojs),
        hls: Boolean(window.Hls),
        dashjs: Boolean(window.dashjs),
      };

      return {
        video_count: videos.length,
        player_libraries: libraries,
        videos: videos.map((video, index) => ({
          index,
          current_src: video.currentSrc || video.src || "",
          paused: Boolean(video.paused),
          ready_state: Number(video.readyState || 0),
          network_state: Number(video.networkState || 0),
          current_time: Number(video.currentTime || 0),
          duration: Number(video.duration || 0),
          muted: Boolean(video.muted),
        })),
      };
    });
  } catch (error) {
    return {
      video_count: 0,
      player_libraries: {},
      videos: [],
      error: error.message,
    };
  }
}
