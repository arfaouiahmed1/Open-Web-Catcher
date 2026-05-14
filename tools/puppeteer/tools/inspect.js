import {
  detectAccessStateFromSignals,
  withBrowserSession,
} from "../shared/tool-runtime.js";
import { screenshotViewport } from "../shared/screenshot.js";

const DEFAULT_CONFIG = {
  url: "",
  wait_ms: 1200,
  max_depth: 8,
  max_children_per_node: 60,
  max_links: 450,
  max_interactive_elements: 450,
  max_tables: 40,
  max_table_rows: 80,
  max_table_cells: 20,
  max_iframes: 80,
  max_videos: 50,
  max_audio: 50,
  max_images: 220,
  max_sources: 220,
  max_tracks: 120,
  max_forms: 50,
  max_form_inputs: 45,
  max_frames: 24,
  frame_eval_timeout_ms: 9000,
  include_network: true,
  include_response_bodies: false,
  include_frames: true,
  include_shadow_dom: true,
  scroll: false,
  scroll_steps: 0,
  allow_safe_interactions: false,
  safe_interaction_limit: 0,
  scanMode: "default",
  include_screenshot: true,
};

const OBSERVATION_SCHEMA_VERSION = "clean_browser_observation/v1";

const normalizeWhitespace = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

function toBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function toInteger(value, fallback, min = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

export function normalizeInspectConfig(params = {}) {
  return {
    url: String(params.url || "").trim(),
    wait_ms: toInteger(params.wait_ms, DEFAULT_CONFIG.wait_ms, 0),
    max_depth: toInteger(params.max_depth, DEFAULT_CONFIG.max_depth, 0),
    max_children_per_node: toInteger(
      params.max_children_per_node,
      DEFAULT_CONFIG.max_children_per_node,
      0,
    ),
    max_links: toInteger(params.max_links, DEFAULT_CONFIG.max_links, 1),
    max_interactive_elements: toInteger(
      params.max_interactive_elements,
      DEFAULT_CONFIG.max_interactive_elements,
      1,
    ),
    max_tables: toInteger(params.max_tables, DEFAULT_CONFIG.max_tables, 1),
    max_table_rows: toInteger(
      params.max_table_rows,
      DEFAULT_CONFIG.max_table_rows,
      1,
    ),
    max_table_cells: toInteger(
      params.max_table_cells,
      DEFAULT_CONFIG.max_table_cells,
      1,
    ),
    max_iframes: toInteger(params.max_iframes, DEFAULT_CONFIG.max_iframes, 1),
    max_videos: toInteger(params.max_videos, DEFAULT_CONFIG.max_videos, 1),
    max_audio: toInteger(params.max_audio, DEFAULT_CONFIG.max_audio, 1),
    max_images: toInteger(params.max_images, DEFAULT_CONFIG.max_images, 1),
    max_sources: toInteger(params.max_sources, DEFAULT_CONFIG.max_sources, 1),
    max_tracks: toInteger(params.max_tracks, DEFAULT_CONFIG.max_tracks, 1),
    max_forms: toInteger(params.max_forms, DEFAULT_CONFIG.max_forms, 1),
    max_form_inputs: toInteger(
      params.max_form_inputs,
      DEFAULT_CONFIG.max_form_inputs,
      1,
    ),
    max_frames: toInteger(params.max_frames, DEFAULT_CONFIG.max_frames, 1),
    frame_eval_timeout_ms: toInteger(
      params.frame_eval_timeout_ms,
      DEFAULT_CONFIG.frame_eval_timeout_ms,
      1000,
    ),
    include_network: toBoolean(
      params.include_network,
      DEFAULT_CONFIG.include_network,
    ),
    include_response_bodies: toBoolean(
      params.include_response_bodies,
      DEFAULT_CONFIG.include_response_bodies,
    ),
    include_frames: toBoolean(
      params.include_frames,
      DEFAULT_CONFIG.include_frames,
    ),
    include_shadow_dom: toBoolean(
      params.include_shadow_dom,
      DEFAULT_CONFIG.include_shadow_dom,
    ),
    scroll: toBoolean(params.scroll, DEFAULT_CONFIG.scroll),
    scroll_steps: toInteger(
      params.scroll_steps,
      DEFAULT_CONFIG.scroll_steps,
      0,
    ),
    allow_safe_interactions: toBoolean(
      params.allow_safe_interactions,
      DEFAULT_CONFIG.allow_safe_interactions,
    ),
    safe_interaction_limit: toInteger(
      params.safe_interaction_limit,
      DEFAULT_CONFIG.safe_interaction_limit,
      0,
    ),
    scanMode:
      normalizeWhitespace(
        params.scanMode || params.scan_mode || DEFAULT_CONFIG.scanMode,
      ).toLowerCase() || "default",
    include_screenshot: toBoolean(
      params.include_screenshot,
      DEFAULT_CONFIG.include_screenshot,
    ),
  };
}

function textHash(value) {
  const text = normalizeWhitespace(value);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}

function frameDepth(framePath) {
  if (!framePath || framePath === "root") return 0;
  return framePath.split(".").length - 1;
}

function buildFramePathMap(page) {
  const map = new Map();
  const root = page.mainFrame();
  map.set(root, "root");

  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift();
    const currentPath = map.get(current) || "root";
    const children = current.childFrames();
    children.forEach((child, index) => {
      const childPath = `${currentPath}.${index}`;
      map.set(child, childPath);
      queue.push(child);
    });
  }

  return map;
}

async function computeFrameOffset(frame) {
  let x = 0;
  let y = 0;
  let current = frame;

  while (current.parentFrame()) {
    try {
      const frameElement = await current.frameElement();
      const box = await frameElement.boundingBox();
      if (box) {
        x += box.x;
        y += box.y;
      }
      await frameElement.dispose().catch(() => {});
    } catch {
      break;
    }
    current = current.parentFrame();
  }

  return { x: Math.round(x), y: Math.round(y) };
}

function isTextLikeContentType(contentType = "") {
  return /json|javascript|xml|html|text|graphql|x-www-form-urlencoded/.test(
    String(contentType).toLowerCase(),
  );
}

function createNetworkRecorder(page, config, startTime = Date.now()) {
  const requests = [];
  const responses = [];
  const requestIds = new WeakMap();
  let requestCounter = 0;

  const onRequest = (request) => {
    if (!config.include_network) return;
    requestCounter += 1;
    const requestId = `request-${requestCounter}`;
    requestIds.set(request, requestId);
    requests.push({
      request_id: requestId,
      url: request.url(),
      method: request.method(),
      resource_type: request.resourceType(),
      frame_url: request.frame()?.url?.() || "",
      initiator: request.isNavigationRequest()
        ? "navigation"
        : request.resourceType(),
      timestamp: Date.now(),
    });
  };

  const onResponse = async (response) => {
    if (!config.include_network) return;
    const request = response.request();
    const headers = response.headers();
    const contentType =
      headers["content-type"] || headers["Content-Type"] || "";
    const item = {
      request_id: requestIds.get(request) || `request-${responses.length + 1}`,
      url: response.url(),
      status: response.status(),
      content_type: contentType,
      request_method: request.method(),
      resource_type: request.resourceType(),
      frame_url: request.frame()?.url?.() || "",
      body_preview: "",
      body_truncated: false,
    };

    if (config.include_response_bodies && isTextLikeContentType(contentType)) {
      try {
        item.body_preview = await response.text();
      } catch {
        item.body_preview = "";
      }
    }

    responses.push(item);
  };

  page.on("request", onRequest);
  page.on("response", onResponse);

  return {
    requests,
    responses,
    startTime,
    dispose: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

async function installMutationObserver(page) {
  await page
    .evaluate(() => {
      try {
        if (window.__owcMutationObserver) {
          window.__owcMutationObserver.disconnect();
        }

        window.__owcMutations = [];
        window.__owcMutationStartedAt = performance.now();

        const observer = new MutationObserver((records) => {
          const now = performance.now();
          const bucket = Array.isArray(window.__owcMutations)
            ? window.__owcMutations
            : [];

          for (const record of records) {
            bucket.push({
              type: record.type,
              targetTag: record.target?.tagName?.toLowerCase?.() || "",
              selector: record.target?.id
                ? `#${record.target.id}`
                : record.target?.tagName?.toLowerCase?.() || "",
              added: record.addedNodes?.length || 0,
              removed: record.removedNodes?.length || 0,
              attributeName: record.attributeName || "",
              oldValue: record.oldValue || "",
              newValue: record.attributeName
                ? record.target?.getAttribute?.(record.attributeName) || ""
                : "",
              newText:
                record.type === "characterData"
                  ? String(record.target?.data || "")
                  : "",
              time: Math.round(now - (window.__owcMutationStartedAt || now)),
            });
          }

          window.__owcMutations = bucket;
        });

        observer.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeOldValue: true,
          characterData: true,
          characterDataOldValue: true,
        });

        window.__owcMutationObserver = observer;
      } catch {
        window.__owcMutations = [];
      }
    })
    .catch(() => {});
}

async function collectMutationSummary(page, phase) {
  return page
    .evaluate((phaseName) => {
      const raw = Array.isArray(window.__owcMutations)
        ? window.__owcMutations
        : [];
      window.__owcMutations = [];

      return {
        phase: phaseName,
        timestamp_offset_ms: raw.at(-1)?.time || 0,
        added_nodes: raw.reduce(
          (sum, entry) => sum + Number(entry.added || 0),
          0,
        ),
        removed_nodes: raw.reduce(
          (sum, entry) => sum + Number(entry.removed || 0),
          0,
        ),
        changed_attributes: raw
          .filter((entry) => entry.type === "attributes" && entry.attributeName)
          .map((entry) => ({
            selector: entry.selector || "",
            attribute: entry.attributeName,
            old_value: String(entry.oldValue || ""),
            new_value: String(entry.newValue || ""),
          })),
        text_changes: raw
          .filter((entry) => entry.type === "characterData")
          .map((entry) => ({
            selector: entry.selector || "",
            old_text: String(entry.oldValue || ""),
            new_text_preview: String(entry.newText || ""),
          })),
      };
    }, phase)
    .catch(() => ({
      phase,
      timestamp_offset_ms: 0,
      added_nodes: 0,
      removed_nodes: 0,
      changed_attributes: [],
      text_changes: [],
    }));
}

async function extractStorage(page) {
  const storage = await page
    .evaluate(() => ({
      local_storage_keys: Object.keys(window.localStorage || {}),
      session_storage_keys: Object.keys(window.sessionStorage || {}),
    }))
    .catch(() => ({
      local_storage_keys: [],
      session_storage_keys: [],
    }));

  const cookies = await page.cookies().catch(() => []);
  return {
    local_storage_keys: storage.local_storage_keys,
    session_storage_keys: storage.session_storage_keys,
    cookies_summary: cookies.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      sameSite: cookie.sameSite || "Unknown",
    })),
  };
}

export function buildNetworkSummary(
  requests = [],
  responses = [],
  startTime = Date.now(),
) {
  const resource_summary = {
    document: 0,
    script: 0,
    stylesheet: 0,
    image: 0,
    xhr: 0,
    fetch: 0,
    media: 0,
    websocket: 0,
    other: 0,
  };

  const normalizedRequests = requests.map((entry, index) => {
    const resourceType = String(entry.resource_type || "other").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(resource_summary, resourceType)) {
      resource_summary[resourceType] += 1;
    } else {
      resource_summary.other += 1;
    }

    return {
      request_id: entry.request_id || `request-${index + 1}`,
      url: entry.url,
      method: entry.method,
      resource_type: entry.resource_type,
      frame_url: entry.frame_url,
      initiator: entry.initiator || "",
      timestamp_offset_ms: Math.max(
        0,
        Number(entry.timestamp || startTime) - Number(startTime || 0),
      ),
    };
  });

  const normalizedResponses = responses.map((entry, index) => ({
    request_id: entry.request_id || `request-${index + 1}`,
    url: entry.url,
    status: entry.status,
    content_type: entry.content_type,
    resource_type: entry.resource_type,
    frame_url: entry.frame_url,
    body_preview: entry.body_preview || "",
    body_truncated: Boolean(entry.body_truncated),
  }));

  return {
    resource_summary,
    requests: normalizedRequests,
    responses: normalizedResponses,
  };
}

function previewJson(value) {
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 5),
    };
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    const sample = {};
    for (const key of keys.slice(0, 10)) {
      sample[key] = value[key];
    }
    return {
      type: "object",
      keys,
      sample,
    };
  }

  return {
    type: typeof value,
    sample: value,
  };
}

export function buildDataResponses(responseLog = []) {
  const out = [];

  for (const entry of responseLog) {
    const contentType = String(entry.content_type || "").toLowerCase();
    if (!/json|graphql/.test(contentType)) continue;
    if (!entry.body_preview) continue;

    try {
      const parsed = JSON.parse(entry.body_preview);
      out.push({
        request_id: entry.request_id,
        url: entry.url,
        content_type: entry.content_type,
        status: entry.status,
        json_preview: previewJson(parsed),
      });
    } catch {
      out.push({
        request_id: entry.request_id,
        url: entry.url,
        content_type: entry.content_type,
        status: entry.status,
        parse_error: "invalid_json_preview",
        body_preview: entry.body_preview,
      });
    }
  }

  return out;
}

function extractPageObservation(configInput = {}) {
  const config = {
    max_depth: Number(configInput.max_depth || 0),
    max_children_per_node: Number(configInput.max_children_per_node || 0),
    max_links: Number(configInput.max_links || 0),
    max_interactive_elements: Number(configInput.max_interactive_elements || 0),
    max_tables: Number(configInput.max_tables || 0),
    max_table_rows: Number(configInput.max_table_rows || 0),
    max_table_cells: Number(configInput.max_table_cells || 0),
    max_iframes: Number(configInput.max_iframes || 0),
    max_videos: Number(configInput.max_videos || 0),
    max_audio: Number(configInput.max_audio || 0),
    max_images: Number(configInput.max_images || 0),
    max_sources: Number(configInput.max_sources || 0),
    max_tracks: Number(configInput.max_tracks || 0),
    max_forms: Number(configInput.max_forms || 0),
    max_form_inputs: Number(configInput.max_form_inputs || 0),
    include_shadow_dom: Boolean(configInput.include_shadow_dom),
    treeOnly: Boolean(configInput.treeOnly),
  };

  const normalizeText = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const unlimitedDepth = config.max_depth <= 0;
  const unlimitedChildren = config.max_children_per_node <= 0;
  const limitCollection = (items, max) =>
    max > 0 ? items.slice(0, max) : items;
  const keptHiddenMeaningfully = true;
  const removedTags = new Set(["script", "style", "noscript", "template"]);
  const meaningfulTags = new Set([
    "html",
    "body",
    "main",
    "article",
    "section",
    "nav",
    "header",
    "footer",
    "aside",
    "form",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "video",
    "audio",
    "img",
    "picture",
    "source",
    "track",
    "iframe",
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "label",
    "summary",
    "details",
    "canvas",
    "svg",
    "figure",
    "figcaption",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
  ]);

  let nodeCounter = 0;
  let removedHiddenNodes = 0;
  const nodeIds = new WeakMap();
  const limitsReached = [];

  function nextNodeId() {
    nodeCounter += 1;
    return `node-${nodeCounter}`;
  }

  function getNodeId(node) {
    if (!nodeIds.has(node)) nodeIds.set(node, nextNodeId());
    return nodeIds.get(node);
  }

  function cssEscape(value) {
    try {
      return CSS.escape(String(value));
    } catch {
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "");
    }
  }

  function uniqueIdSelector(el) {
    const id = el.getAttribute?.("id");
    if (!id) return "";
    const selector = `#${cssEscape(id)}`;
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch {
      return "";
    }
    return "";
  }

  function getSelector(el) {
    if (!(el instanceof Element)) return "";
    const idSelector = uniqueIdSelector(el);
    if (idSelector) return idSelector;

    const parts = [];
    let current = el;
    let depth = 0;
    while (current && current.nodeType === 1 && depth < 8) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTagSiblings = Array.from(parent.children).filter(
        (child) => child.tagName === current.tagName,
      );
      const index = sameTagSiblings.indexOf(current) + 1;
      parts.unshift(
        sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag,
      );
      const parentId = uniqueIdSelector(parent);
      if (parentId) {
        parts.unshift(parentId);
        break;
      }
      current = parent;
      depth += 1;
    }
    return parts.join(" > ");
  }

  function getBBox(el) {
    if (!(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function ownText(node) {
    if (!(node instanceof Element)) return "";
    const text = Array.from(node.childNodes || [])
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.textContent || "")
      .join(" ");
    return normalizeText(text);
  }

  function allText(node) {
    if (!(node instanceof Element)) return "";
    return normalizeText(node.innerText || node.textContent || "");
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function hasMeaningfulAttributes(el) {
    if (!(el instanceof Element)) return false;
    return Array.from(el.attributes || []).some((attr) => {
      const name = String(attr.name || "").toLowerCase();
      return Boolean(name) && normalizeText(attr.value).length > 0;
    });
  }

  function shouldKeepElement(el) {
    const tag = String(el?.tagName || "").toLowerCase();
    if (meaningfulTags.has(tag)) return true;
    if (isVisible(el)) return true;
    if (ownText(el)) return true;
    return hasMeaningfulAttributes(el);
  }

  function getAttributes(el) {
    if (!(el instanceof Element)) return {};
    const attrs = {};
    for (const attr of Array.from(el.attributes || [])) {
      attrs[attr.name] = normalizeText(attr.value);
    }
    return attrs;
  }

  function nodeToTree(node, depth = 0) {
    if (!(node instanceof Element)) return null;

    const tag = node.tagName.toLowerCase();
    if (removedTags.has(tag)) return null;
    if (!shouldKeepElement(node)) {
      if (!isVisible(node)) removedHiddenNodes += 1;
      return null;
    }
    if (!unlimitedDepth && depth > config.max_depth) {
      limitsReached.push({
        field: "tree_depth",
        limit: config.max_depth,
        actual_estimate: depth,
      });
      return null;
    }

    const children = Array.from(node.children || []);
    const childLimit = unlimitedChildren
      ? children.length
      : config.max_children_per_node;
    if (!unlimitedChildren && children.length > childLimit) {
      limitsReached.push({
        field: "tree_children",
        limit: childLimit,
        actual_estimate: children.length,
      });
    }

    const out = {
      node_id: getNodeId(node),
      tag,
      selector: getSelector(node),
      text: ownText(node),
      text_preview: ownText(node),
      attributes: getAttributes(node),
      visible: isVisible(node),
      bbox: getBBox(node),
      children: [],
    };

    for (const child of children.slice(0, childLimit)) {
      const childNode = nodeToTree(child, depth + 1);
      if (childNode) out.children.push(childNode);
    }

    return out;
  }

  function previewJsonValue(value) {
    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        sample: value.slice(0, 5),
      };
    }

    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      const sample = {};
      for (const key of keys.slice(0, 10)) {
        sample[key] = value[key];
      }
      return {
        type: "object",
        keys,
        sample,
      };
    }

    return {
      type: typeof value,
      sample: value,
    };
  }

  function getXPath(el) {
    if (!(el instanceof Element)) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let index = 1;
      let sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === node.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(`${node.tagName.toLowerCase()}[${index}]`);
      node = node.parentElement;
    }
    return `//${parts.join("/")}`;
  }

  function extractMetadata() {
    const meta = Array.from(document.querySelectorAll("meta"))
      .map((el) => ({
        name: el.getAttribute("name") || "",
        property: el.getAttribute("property") || "",
        content: el.getAttribute("content") || "",
      }))
      .filter((item) => item.name || item.property || item.content);

    const canonical =
      document.querySelector('link[rel="canonical"]')?.getAttribute("href") ||
      "";
    const description =
      document
        .querySelector('meta[name="description"]')
        ?.getAttribute("content") || "";
    const json_ld = Array.from(
      document.querySelectorAll('script[type="application/ld+json"]'),
    ).map((script, index) => {
      try {
        const parsed = JSON.parse(script.textContent || "{}");
        return {
          script_index: index,
          type: typeof parsed,
          keys: Object.keys(parsed || {}),
          preview: previewJsonValue(parsed),
        };
      } catch {
        return {
          script_index: index,
          parse_error: "invalid_json_ld",
          text_preview: script.textContent || "",
        };
      }
    });

    return {
      title: document.title || "",
      description,
      canonical,
      meta,
      json_ld,
    };
  }

  function extractOutline() {
    return {
      headings: Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map(
        (heading) => ({
          level: Number(heading.tagName[1]),
          selector: getSelector(heading),
          text: allText(heading),
        }),
      ),
      landmarks: Array.from(
        document.querySelectorAll(
          "main,nav,header,footer,aside,section,article,form",
        ),
      ).map((el) => ({
        tag: el.tagName.toLowerCase(),
        selector: getSelector(el),
        text_preview: allText(el),
      })),
    };
  }

  function nearestRegion(el) {
    return el.closest("main,nav,header,footer,aside,section,article,form");
  }

  function extractRegions() {
    return Array.from(
      document.querySelectorAll(
        "main,nav,header,footer,aside,section,article,form",
      ),
    ).map((el) => ({
      selector: getSelector(el),
      tag: el.tagName.toLowerCase(),
      text_preview: allText(el),
      children_count: el.children.length,
      links_count: el.querySelectorAll("a[href]").length,
      buttons_count: el.querySelectorAll(
        'button,[role="button"],[role="tab"],select',
      ).length,
    }));
  }

  function extractLinks() {
    return limitCollection(
      Array.from(document.querySelectorAll("a[href]")),
      config.max_links,
    ).map((a) => ({
      href: a.href || "",
      raw_href: a.getAttribute("href") || "",
      text: allText(a),
      selector: getSelector(a),
      xpath: getXPath(a),
      node_id: getNodeId(a),
      visible: isVisible(a),
      region_selector: nearestRegion(a) ? getSelector(nearestRegion(a)) : "",
      ancestor_text_preview: nearestRegion(a) ? allText(nearestRegion(a)) : "",
      attributes: getAttributes(a),
      bbox: getBBox(a),
    }));
  }

  function extractInteractive() {
    const selector =
      'button,a[href],input,textarea,select,[role="button"],[role="tab"],[onclick],[data-server],[data-source],[data-embed],summary,details';
    return limitCollection(
      Array.from(document.querySelectorAll(selector)),
      config.max_interactive_elements,
    ).map((el) => {
      const style = window.getComputedStyle(el);
      return {
        node_id: getNodeId(el),
        selector: getSelector(el),
        xpath: getXPath(el),
        tag: el.tagName.toLowerCase(),
        text: allText(el) || normalizeText(el.value || ""),
        visible: isVisible(el),
        disabled: Boolean(el.disabled),
        attributes: getAttributes(el),
        event_attributes: {
          onclick: el.getAttribute("onclick") || "",
        },
        computed: {
          cursor: style.cursor || "",
          pointer_events: style.pointerEvents || "",
        },
        bbox: getBBox(el),
      };
    });
  }

  function extractTables() {
    return limitCollection(
      Array.from(document.querySelectorAll("table")),
      config.max_tables,
    ).map(
      (table, tableIndex) => {
        const headers = Array.from(table.querySelectorAll("thead th")).map(
          (th) => allText(th),
        );
        const rows = limitCollection(
          Array.from(table.querySelectorAll("tbody tr, tr")),
          config.max_table_rows,
        ).map(
          (row, rowIndex) => ({
            row_index: rowIndex,
            selector: getSelector(row),
            cells: limitCollection(
              Array.from(row.querySelectorAll("th,td")),
              config.max_table_cells,
            ).map(
              (cell, columnIndex) => ({
                column: headers[columnIndex] || `col_${columnIndex + 1}`,
                text: allText(cell),
                links: Array.from(cell.querySelectorAll("a[href]")).map(
                  (link) => ({
                    href: link.href || "",
                    text: allText(link),
                  }),
                ),
                buttons: Array.from(
                  cell.querySelectorAll('button,[role="button"]'),
                ).map((button) => ({
                  text: allText(button),
                  selector: getSelector(button),
                })),
              }),
            ),
            attributes: getAttributes(row),
          }),
        );

        return {
          table_id: `table-${tableIndex + 1}`,
          node_id: getNodeId(table),
          selector: getSelector(table),
          caption: allText(table.querySelector("caption")),
          headers,
          row_count: rows.length,
          column_count: Math.max(headers.length, rows[0]?.cells?.length || 0),
          rows,
        };
      },
    );
  }

  function extractMedia() {
    return {
      iframes: limitCollection(
        Array.from(document.querySelectorAll("iframe")),
        config.max_iframes,
      ).map(
        (frame, index) => ({
          frame_id: `iframe-${index + 1}`,
          node_id: getNodeId(frame),
          selector: getSelector(frame),
          xpath: getXPath(frame),
          src:
            frame.src ||
            frame.getAttribute("src") ||
            frame.getAttribute("data-src") ||
            "",
          name: frame.name || "",
          title: frame.title || "",
          visible: isVisible(frame),
          sandbox: frame.getAttribute("sandbox") || "",
          allow: frame.getAttribute("allow") || "",
          referrerpolicy: frame.getAttribute("referrerpolicy") || "",
          loading: frame.getAttribute("loading") || "",
          bbox: getBBox(frame),
          accessible_dom: false,
          frame_url_after_load: null,
        }),
      ),
      videos: limitCollection(
        Array.from(document.querySelectorAll("video")),
        config.max_videos,
      ).map((video) => ({
        node_id: getNodeId(video),
        selector: getSelector(video),
        xpath: getXPath(video),
        src: video.getAttribute("src") || "",
        current_src: video.currentSrc || "",
        poster: video.poster || "",
        controls: Boolean(video.controls),
        autoplay: Boolean(video.autoplay),
        muted: Boolean(video.muted),
        loop: Boolean(video.loop),
        playsinline: Boolean(video.playsInline),
        preload: video.preload || "",
        ready_state: Number(video.readyState || 0),
        network_state: Number(video.networkState || 0),
        duration: Number.isFinite(video.duration)
          ? Number(video.duration)
          : null,
        paused: Boolean(video.paused),
        visible: isVisible(video),
        bbox: getBBox(video),
        sources: Array.from(video.querySelectorAll("source")).map((source) => ({
          src: source.src || source.getAttribute("src") || "",
          type: source.type || source.getAttribute("type") || "",
        })),
      })),
      audio: limitCollection(
        Array.from(document.querySelectorAll("audio")),
        config.max_audio,
      ).map((audio) => ({
        node_id: getNodeId(audio),
        selector: getSelector(audio),
        xpath: getXPath(audio),
        src: audio.getAttribute("src") || "",
        current_src: audio.currentSrc || "",
        controls: Boolean(audio.controls),
        autoplay: Boolean(audio.autoplay),
        muted: Boolean(audio.muted),
        loop: Boolean(audio.loop),
        preload: audio.preload || "",
        ready_state: Number(audio.readyState || 0),
        network_state: Number(audio.networkState || 0),
        paused: Boolean(audio.paused),
        visible: isVisible(audio),
        bbox: getBBox(audio),
      })),
      images: limitCollection(
        Array.from(document.querySelectorAll("img")),
        config.max_images,
      ).map((img) => ({
        node_id: getNodeId(img),
        selector: getSelector(img),
        xpath: getXPath(img),
        src: img.currentSrc || img.src || "",
        alt: img.alt || "",
        title: img.title || "",
        loading: img.loading || "",
        visible: isVisible(img),
        bbox: getBBox(img),
      })),
      sources: limitCollection(
        Array.from(document.querySelectorAll("source")),
        config.max_sources,
      ).map(
        (source) => ({
          selector: getSelector(source),
          xpath: getXPath(source),
          parent_selector: getSelector(source.parentElement),
          src: source.src || source.getAttribute("src") || "",
          type: source.type || source.getAttribute("type") || "",
        }),
      ),
      tracks: limitCollection(
        Array.from(document.querySelectorAll("track")),
        config.max_tracks,
      ).map((track) => ({
        selector: getSelector(track),
        xpath: getXPath(track),
        src: track.src || track.getAttribute("src") || "",
        kind: track.kind || track.getAttribute("kind") || "",
        label: track.label || track.getAttribute("label") || "",
        srclang: track.srclang || track.getAttribute("srclang") || "",
      })),
    };
  }

  function extractForms() {
    return limitCollection(Array.from(document.forms), config.max_forms).map((form, formIndex) => ({
      form_id: `form-${formIndex + 1}`,
      selector: getSelector(form),
      method: (form.getAttribute("method") || form.method || "").toLowerCase(),
      action: form.action || form.getAttribute("action") || "",
      text_preview: allText(form),
      inputs: limitCollection(
        Array.from(form.querySelectorAll("input,textarea,select,button")),
        config.max_form_inputs,
      ).map((input) => ({
        selector: getSelector(input),
        xpath: getXPath(input),
        tag: input.tagName.toLowerCase(),
        type: input.getAttribute("type") || "",
        name: input.getAttribute("name") || "",
        placeholder: input.getAttribute("placeholder") || "",
        value: normalizeText(input.value || ""),
        text: allText(input),
        visible: isVisible(input),
        attributes: getAttributes(input),
        bbox: getBBox(input),
      })),
    }));
  }

  function extractUrlLikeStrings(text) {
    const out = [];
    const regex =
      /https?:\/\/[^\s"'`<>]+|\/(?:api|embed|stream|player|watch)[^\s"'`<>]*/gi;
    let match;
    while ((match = regex.exec(String(text || "")))) {
      out.push(match[0]);
    }
    return out;
  }

  function guessNearbyKey(text, value) {
    const index = String(text || "").indexOf(value);
    if (index < 0) return "";
    const nearby = String(text || "").slice(
      Math.max(0, index - 120),
      index + value.length + 40,
    );
    const match = nearby.match(/["']?([a-zA-Z0-9_-]{2,80})["']?\s*[:=]\s*$/);
    return match?.[1] || "";
  }

  function extractObjectKeySamples(text) {
    const keys = [];
    const regex = /["']([a-zA-Z0-9_-]{2,120})["']\s*:/g;
    let match;
    while ((match = regex.exec(String(text || "")))) {
      if (!keys.includes(match[1])) keys.push(match[1]);
    }
    return keys;
  }

  function extractScripts() {
    const scripts = Array.from(document.querySelectorAll("script"));
    const external = scripts
      .filter((script) => script.src)
      .map((script) => ({
        src: script.src,
        async: Boolean(script.async),
        defer: Boolean(script.defer),
        type: script.type || "",
      }));

    const inline_summaries = [];
    const script_url_strings = [];
    const script_object_keys = [];

    scripts.forEach((script, scriptIndex) => {
      const text = String(script.textContent || "");
      if (!text) return;
      const urls = extractUrlLikeStrings(text);
      const keys = extractObjectKeySamples(text);

      inline_summaries.push({
        script_index: scriptIndex,
        length: text.length,
        contains_eval: /\beval\s*\(/.test(text),
        contains_fetch: /\bfetch\s*\(/.test(text),
        contains_xhr: /XMLHttpRequest/.test(text),
        contains_websocket: /WebSocket/.test(text),
        contains_iframe_write:
          /iframe/.test(text) && /write|appendChild|innerHTML/.test(text),
        contains_location_assignment: /location\s*=|location\.href\s*=/.test(
          text,
        ),
        contains_event_listeners: /addEventListener/.test(text),
        string_url_count: urls.length,
        object_key_samples: keys,
      });

      urls.forEach((value) => {
        script_url_strings.push({
          source: `inline:${scriptIndex}`,
          value,
          nearby_key: guessNearbyKey(text, value),
        });
      });

      if (keys.length > 0) {
        script_object_keys.push({
          source: `inline:${scriptIndex}`,
          keys,
        });
      }
    });

    return {
      external,
      inline_summaries,
      script_url_strings,
      script_object_keys,
    };
  }

  function signature(el) {
    const tag = el.tagName.toLowerCase();
    const attrs = Object.keys(getAttributes(el)).sort().join("|");
    const childTags = Array.from(el.children)
      .map((child) => child.tagName.toLowerCase())
      .join("|");
    const hasLink = el.querySelector("a[href]") ? "1" : "0";
    const hasButton = el.querySelector('button,[role="button"]') ? "1" : "0";
    const hasMedia = el.querySelector("video,img,iframe") ? "1" : "0";
    return `${tag}::${attrs}::${childTags}::${hasLink}${hasButton}${hasMedia}`;
  }

  function groupBySignature(elements) {
    const map = new Map();
    for (const element of elements) {
      const sig = signature(element);
      if (!map.has(sig)) map.set(sig, []);
      map.get(sig).push(element);
    }
    return map;
  }

  function common(values) {
    const counts = new Map();
    values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([value]) => value);
  }

  function commonAttributeNames(elements) {
    const counts = new Map();
    elements.forEach((el) => {
      Array.from(el.attributes || []).forEach((attr) => {
        counts.set(attr.name, (counts.get(attr.name) || 0) + 1);
      });
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([value]) => value);
  }

  function commonClassTokens(elements) {
    const counts = new Map();
    elements.forEach((el) => {
      String(el.className || "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((token) => {
          counts.set(token, (counts.get(token) || 0) + 1);
        });
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([value]) => value);
  }

  function extractRepeatedStructures() {
    const structures = [];
    const containers = Array.from(
      document.querySelectorAll("main,section,article,ul,ol,div"),
    );
    let structureIndex = 0;

    for (const container of containers) {
      const children = Array.from(container.children || []).filter((child) =>
        shouldKeepElement(child),
      );
      if (children.length < 3) continue;
      const groups = groupBySignature(children);
      for (const items of groups.values()) {
        if (items.length < 3) continue;
        structureIndex += 1;
        structures.push({
          structure_id: `structure-${structureIndex}`,
          container_node_id: getNodeId(container),
          container_selector: getSelector(container),
          container_tag: container.tagName.toLowerCase(),
          item_count: items.length,
          visible_item_count: items.filter((item) => isVisible(item)).length,
          common_child_tag:
            common(items.map((item) => item.tagName.toLowerCase()))[0] || "",
          common_attribute_names: commonAttributeNames(items),
          common_class_tokens: commonClassTokens(items),
          average_text_length: Math.round(
            items.reduce((sum, item) => sum + allText(item).length, 0) /
              items.length,
          ),
          text_samples: items.map((item) => allText(item)),
          items: items.map((item) => ({
            node_id: getNodeId(item),
            selector: getSelector(item),
            tag: item.tagName.toLowerCase(),
            text: allText(item),
            attributes: getAttributes(item),
            bbox: getBBox(item),
          })),
        });
      }
    }

    return structures;
  }

  function shadowRootToTree(node, depth = 0) {
    if (!node) return null;
    if (!unlimitedDepth && depth > config.max_depth) return null;

    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeText(node.textContent || "");
      return text ? { tag: "#text", text } : null;
    }

    if (!(node instanceof Element) && !(node instanceof ShadowRoot))
      return null;

    const childNodes = Array.from(node.childNodes || []);
    const childLimit = unlimitedChildren
      ? childNodes.length
      : config.max_children_per_node;
    const children = [];
    for (const child of childNodes.slice(0, childLimit)) {
      const value = shadowRootToTree(child, depth + 1);
      if (value) children.push(value);
    }

    return {
      tag:
        node instanceof ShadowRoot
          ? "#shadow-root"
          : node.tagName.toLowerCase(),
      selector: node instanceof Element ? getSelector(node) : "",
      text: node instanceof Element ? allText(node) : "",
      visible: node instanceof Element ? isVisible(node) : true,
      attributes: node instanceof Element ? getAttributes(node) : {},
      children,
    };
  }

  function extractShadowRoots() {
    if (!config.include_shadow_dom) return [];
    const result = [];
    const all = Array.from(document.querySelectorAll("*"));
    for (const host of all) {
      if (!host.shadowRoot) continue;
      result.push({
        host_selector: getSelector(host),
        mode: host.shadowRoot.mode || "open",
        tree: shadowRootToTree(host.shadowRoot, 0),
      });
    }
    return result;
  }

  function countTreeNodes(node) {
    if (!node) return 0;
    return (
      1 +
      (node.children || []).reduce(
        (sum, child) => sum + countTreeNodes(child),
        0,
      )
    );
  }

  function maxTreeDepth(node, depth = 0) {
    if (!node || !Array.isArray(node.children) || node.children.length === 0)
      return depth;
    return Math.max(
      ...node.children.map((child) => maxTreeDepth(child, depth + 1)),
    );
  }

  const root = document.body || document.documentElement;
  const tree = nodeToTree(root, 0);
  if (config.treeOnly) return tree;

  const metadata = extractMetadata();
  const outline = extractOutline();
  const regions = extractRegions();
  const links = extractLinks();
  const interactive_elements = extractInteractive();
  const tables = extractTables();
  const media = extractMedia();
  const forms = extractForms();
  const scripts = extractScripts();
  const repeated_structures = extractRepeatedStructures();
  const shadow_roots = extractShadowRoots();

  return {
    metadata,
    document_stats: {
      original_node_count: document.querySelectorAll("*").length,
      returned_node_count: countTreeNodes(tree),
      removed_node_count: Math.max(
        document.querySelectorAll("*").length - countTreeNodes(tree),
        0,
      ),
      max_depth_returned: maxTreeDepth(tree, 0),
      text_length: normalizeText(document.body?.innerText || "").length,
      link_count: links.length,
      interactive_count: interactive_elements.length,
      iframe_count: media.iframes.length,
      video_count: media.videos.length,
      table_count: tables.length,
      form_count: forms.length,
    },
    outline,
    tree,
    regions,
    repeated_structures,
    tables,
    links,
    interactive_elements,
    forms,
    media,
    shadow_roots,
    scripts,
    pruning: {
      removed_tags: Array.from(removedTags),
      removed_hidden_nodes: removedHiddenNodes,
      kept_hidden_if_meaningful: keptHiddenMeaningfully,
      text_truncation_chars_per_node: 0,
      max_children_per_node: config.max_children_per_node,
      max_depth: config.max_depth,
      limits_reached: limitsReached,
    },
  };
}

async function extractTreeSnapshot(page, config) {
  return page
    .evaluate(extractPageObservation, {
      ...config,
      treeOnly: true,
    })
    .catch(() => null);
}

function hasServerControls(interactiveElements = []) {
  return interactiveElements.some((entry) => {
    const haystack = [
      entry.text,
      entry.selector,
      entry.attributes?.role,
      entry.attributes?.class,
      entry.attributes?.["data-server"],
      entry.attributes?.["data-source"],
      entry.attributes?.["data-embed"],
    ]
      .filter(Boolean)
      .join(" ");
    return /(server|source|mirror|backup|embed|stream|quality|cdn)/i.test(
      haystack,
    );
  });
}

function playerLibraryDetailsFromObservation(observation = {}) {
  const scripts = observation.scripts || {};
  const sources = [
    ...(scripts.external || []).map((entry) => entry.src || ""),
    ...(scripts.script_url_strings || []).map((entry) => entry.value || ""),
  ].join(" ");
  const haystack =
    `${sources} ${JSON.stringify(observation.interactive_elements || [])}`.toLowerCase();

  return {
    jwplayer: /jwplayer/.test(haystack),
    videojs: /videojs|vjs-/.test(haystack),
    hls: /hls\.js|hlsjs|master\.m3u8|\.m3u8/.test(haystack),
    dashjs: /dashjs|\.mpd/.test(haystack),
    clappr: /clappr/.test(haystack),
    albaplayer: /albaplayer/.test(haystack),
    html_player_hint: Boolean(
      (observation.media?.videos || []).length ||
      (observation.media?.iframes || []).length,
    ),
  };
}

function hasPlayerLibrary(observation = {}) {
  return Object.values(playerLibraryDetailsFromObservation(observation)).some(
    Boolean,
  );
}

function computeCenterX(bbox) {
  if (!bbox) return 0;
  return Math.round((bbox.x || 0) + (bbox.width || 0) / 2);
}

function computeCenterY(bbox) {
  if (!bbox) return 0;
  return Math.round((bbox.y || 0) + (bbox.height || 0) / 2);
}

function buildPagination(links = [], interactive = []) {
  const elements = [
    ...links.map((entry) => ({
      text: entry.text,
      href: entry.href,
      selector: entry.selector,
      xpath: entry.xpath || "",
      x: computeCenterX(entry.bbox),
      y: computeCenterY(entry.bbox),
    })),
    ...interactive
      .filter(
        (entry) =>
          ["button", "select", "a"].includes(entry.tag) ||
          entry.attributes?.role === "tab",
      )
      .map((entry) => ({
        text: entry.text,
        href: entry.attributes?.href || "",
        selector: entry.selector,
        xpath: entry.xpath || "",
        x: computeCenterX(entry.bbox),
        y: computeCenterY(entry.bbox),
      })),
  ].filter((entry) =>
    /next|prev|page|older|newer|\b\d+\b/i.test(
      `${entry.text} ${entry.selector}`,
    ),
  );

  return {
    detected: elements.length > 0,
    type: elements.length > 0 ? "numbered_or_navigational" : null,
    elements,
  };
}

function buildLegacyCompatibilityView(
  observation = {},
  pageDigest = {},
  frameRecords = [],
) {
  const links = observation.links || [];
  const interactive = observation.interactive_elements || [];
  const media = observation.media || {
    iframes: [],
    videos: [],
    audio: [],
    images: [],
    sources: [],
    tracks: [],
  };
  const regions = observation.regions || [];
  const forms = observation.forms || [];
  const libraryDetails = playerLibraryDetailsFromObservation(observation);

  const contentLinks = links.map((entry) => ({
    href: entry.href || "",
    raw_href: entry.raw_href || "",
    text: entry.text || "",
    selector: entry.selector || "",
    node_id: entry.node_id || "",
    visible: Boolean(entry.visible),
    region_selector: entry.region_selector || "",
    ancestor_text_preview: entry.ancestor_text_preview || "",
    attributes: entry.attributes || {},
    x: computeCenterX(entry.bbox),
    y: computeCenterY(entry.bbox),
    width: Math.round(entry.bbox?.width || 0),
    height: Math.round(entry.bbox?.height || 0),
    frame_path: "root",
  }));

  const navLinks = contentLinks.filter((entry) => {
    const region = regions.find(
      (item) => item.selector === entry.region_selector,
    );
    return (
      region?.tag === "nav" ||
      /nav|menu|header/i.test(`${entry.region_selector} ${entry.selector}`)
    );
  });

  const buttons = interactive
    .filter(
      (entry) =>
        ["button", "select", "summary", "details"].includes(entry.tag) ||
        ["button", "tab"].includes(entry.attributes?.role || ""),
    )
    .map((entry) => ({
      kind: entry.tag === "select" ? "dropdown" : "button",
      text: entry.text || "",
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      x: computeCenterX(entry.bbox),
      y: computeCenterY(entry.bbox),
      width: Math.round(entry.bbox?.width || 0),
      height: Math.round(entry.bbox?.height || 0),
      visible: Boolean(entry.visible),
      active: Boolean(
        entry.attributes?.["aria-selected"] === "true" ||
        entry.attributes?.["aria-expanded"] === "true",
      ),
      data: {
        server: entry.attributes?.["data-server"] || null,
        source: entry.attributes?.["data-source"] || null,
        embed: entry.attributes?.["data-embed"] || null,
      },
      frame_path: "root",
    }));

  const flattenedFormInputs = forms.flatMap((form) => form.inputs || []);
  const elements = [
    ...contentLinks.map((entry) => ({
      kind: "link",
      tag: "a",
      type: "",
      role: "",
      text: entry.text,
      href: entry.href,
      src: "",
      selector: entry.selector,
      xpath: entry.xpath || "",
      id: entry.attributes?.id || "",
      classes: entry.attributes?.class || "",
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      visible: entry.visible,
      frame_path: "root",
      active: false,
      checked: null,
      disabled: false,
      data: {
        server: entry.attributes?.["data-server"] || null,
        source: entry.attributes?.["data-source"] || null,
        embed: entry.attributes?.["data-embed"] || null,
      },
    })),
    ...interactive.map((entry) => ({
      kind: entry.tag,
      tag: entry.tag,
      type: entry.attributes?.type || "",
      role: entry.attributes?.role || "",
      text: entry.text || "",
      href: entry.attributes?.href || "",
      src: entry.attributes?.src || "",
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      id: entry.attributes?.id || "",
      classes: entry.attributes?.class || "",
      x: computeCenterX(entry.bbox),
      y: computeCenterY(entry.bbox),
      width: Math.round(entry.bbox?.width || 0),
      height: Math.round(entry.bbox?.height || 0),
      visible: Boolean(entry.visible),
      frame_path: "root",
      active: Boolean(
        entry.attributes?.["aria-selected"] === "true" ||
        entry.attributes?.["aria-expanded"] === "true",
      ),
      checked: entry.attributes?.checked === "true" ? true : null,
      disabled: Boolean(entry.disabled),
      data: {
        server: entry.attributes?.["data-server"] || null,
        source: entry.attributes?.["data-source"] || null,
        embed: entry.attributes?.["data-embed"] || null,
      },
    })),
    ...flattenedFormInputs.map((entry) => ({
      kind: entry.tag,
      tag: entry.tag,
      type: entry.type || "",
      role: entry.attributes?.role || "",
      text: entry.text || "",
      href: entry.attributes?.href || "",
      src: entry.attributes?.src || "",
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      id: entry.attributes?.id || "",
      classes: entry.attributes?.class || "",
      x: computeCenterX(entry.bbox),
      y: computeCenterY(entry.bbox),
      width: Math.round(entry.bbox?.width || 0),
      height: Math.round(entry.bbox?.height || 0),
      visible: Boolean(entry.visible),
      frame_path: "root",
      active: Boolean(
        entry.attributes?.["aria-selected"] === "true" ||
        entry.attributes?.["aria-expanded"] === "true",
      ),
      checked: entry.attributes?.checked === "true" ? true : null,
      disabled: Boolean(entry.attributes?.disabled === "true"),
      data: {
        server: entry.attributes?.["data-server"] || null,
        source: entry.attributes?.["data-source"] || null,
        embed: entry.attributes?.["data-embed"] || null,
      },
    })),
  ];

  const iframes = (media.iframes || []).map((entry) => ({
    src: entry.src || "",
    id: entry.attributes?.id || "",
    name: entry.name || "",
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    x: computeCenterX(entry.bbox),
    y: computeCenterY(entry.bbox),
    width: Math.round(entry.bbox?.width || 0),
    height: Math.round(entry.bbox?.height || 0),
    category: /ad|banner|doubleclick|analytics|track/i.test(entry.src || "")
      ? "ad"
      : "content",
  }));

  const videos = (media.videos || []).map((entry) => ({
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    src: entry.current_src || entry.src || "",
    readyState: entry.ready_state,
    networkState: entry.network_state,
    paused: entry.paused,
    duration: entry.duration,
    x: computeCenterX(entry.bbox),
    y: computeCenterY(entry.bbox),
    width: Math.round(entry.bbox?.width || 0),
    height: Math.round(entry.bbox?.height || 0),
  }));

  const popups = interactive
    .filter((entry) =>
      /popup|modal|overlay|cookie|banner/i.test(
        `${entry.selector} ${JSON.stringify(entry.attributes || {})}`,
      ),
    )
    .map((entry) => ({
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      text: entry.text || "",
      close_selector: "",
      close_xpath: "",
      x: computeCenterX(entry.bbox),
      y: computeCenterY(entry.bbox),
      width: Math.round(entry.bbox?.width || 0),
      height: Math.round(entry.bbox?.height || 0),
    }));

  return {
    contentLinks,
    navLinks,
    buttons,
    iframes,
    hosting_signals: {
      has_video: videos.length > 0,
      has_player_iframe: iframes.some(
        (entry) => entry.category === "content" && entry.width > 250,
      ),
      player_iframe_src:
        iframes.find(
          (entry) => entry.category === "content" && entry.width > 250,
        )?.src || null,
      visible_content_iframes: iframes.filter(
        (entry) => entry.category === "content" && entry.width > 100,
      ).length,
      player_libraries: Object.values(libraryDetails).some(Boolean),
      player_libraries_detail: libraryDetails,
      server_tabs: hasServerControls(interactive),
    },
    popups,
    dom_skeleton: regions.map((region) => ({
      tag: region.tag,
      id: "",
      classes: "",
      links: region.links_count,
    })),
    pagination: buildPagination(links, interactive),
    videos,
    elements,
    frame_tree: frameRecords,
    page_digest: {
      text_sample: pageDigest.text_sample || "",
      text_hash: textHash(pageDigest.text_sample || ""),
      html_size: Number(pageDigest.html_size || 0),
      node_count: Number(
        pageDigest.node_count ||
          observation.document_stats?.original_node_count ||
          0,
      ),
    },
  };
}

function buildLegacyFrameRecord(
  frameObservation = {},
  framePath = "root",
  parentPath = null,
  frame = null,
  offset = { x: 0, y: 0 },
) {
  const interactive = frameObservation.interactive_elements || [];
  const media = frameObservation.media || { iframes: [], videos: [] };
  const libraryDetails = playerLibraryDetailsFromObservation(frameObservation);
  const textSample =
    frameObservation.tree?.text || frameObservation.metadata?.description || "";

  const allLinks = (frameObservation.links || []).map((entry) => ({
    href: entry.href || "",
    text: entry.text || "",
    selector: entry.selector || "",
    xpath: entry.xpath || "",
    x: Math.round(computeCenterX(entry.bbox) + offset.x),
    y: Math.round(computeCenterY(entry.bbox) + offset.y),
    width: Math.round(entry.bbox?.width || 0),
    height: Math.round(entry.bbox?.height || 0),
    frame_path: framePath,
  }));

  const allButtons = interactive
    .filter(
      (entry) =>
        ["button", "select", "summary", "details"].includes(entry.tag) ||
        ["button", "tab"].includes(entry.attributes?.role || ""),
    )
    .map((entry) => ({
      text: entry.text || "",
      selector: entry.selector || "",
      xpath: entry.xpath || "",
      x: Math.round(computeCenterX(entry.bbox) + offset.x),
      y: Math.round(computeCenterY(entry.bbox) + offset.y),
      width: Math.round(entry.bbox?.width || 0),
      height: Math.round(entry.bbox?.height || 0),
      frame_path: framePath,
    }));

  const summary = {
    title: frameObservation.metadata?.title || "",
    text_sample: textSample,
    video_count: (media.videos || []).length,
    has_player_library: Object.values(libraryDetails).some(Boolean),
    has_server_controls: hasServerControls(interactive),
  };

  return {
    frame_path: framePath,
    parent_frame_path: parentPath,
    depth: frameDepth(framePath),
    is_main_frame: frame
      ? frame === frame.page().mainFrame()
      : framePath === "root",
    name: frame?.name?.() || "",
    url: frame?.url?.() || "",
    viewport_offset: offset,
    title: summary.title,
    text_sample: summary.text_sample,
    text_hash: textHash(summary.text_sample),
    total_links: allLinks.length,
    total_buttons: allButtons.length,
    total_iframes: (media.iframes || []).length,
    video_count: summary.video_count,
    has_server_controls: summary.has_server_controls,
    has_player_library: summary.has_player_library,
    player_libraries_detail: libraryDetails,
    purpose_hint: inferFramePurpose(summary, frame?.url?.() || ""),
    sample_links: allLinks,
    sample_buttons: allButtons,
    links: allLinks,
    buttons: allButtons,
    error: null,
  };
}

function inferFramePurpose(summary, url) {
  const haystack =
    `${summary.title || ""} ${summary.text_sample || ""} ${url || ""}`.toLowerCase();
  if (summary.video_count > 0 || summary.has_player_library) return "player";
  if (summary.has_server_controls) return "server-controls";
  if (/embed|player|iframe|stream/.test(haystack)) return "player";
  if (/match|fixture|schedule|channels|league/.test(haystack)) return "listing";
  if (/ad|banner|doubleclick|analytics|track/.test(haystack)) return "ad";
  return "unknown";
}

async function extractFrameObservations(page, config) {
  if (!config.include_frames) return { frames: [], frameRecords: [] };

  const pathMap = buildFramePathMap(page);
  const frames = [];
  const frameRecords = [];
  const frameLimit = Math.max(1, Number(config.max_frames || 0));
  const evalTimeoutMs = Math.max(1000, Number(config.frame_eval_timeout_ms || 0));
  const pageFrames = page.frames();
  const targetFrames =
    frameLimit > 0 ? pageFrames.slice(0, frameLimit) : pageFrames;

  for (const frame of targetFrames) {
    const framePath = pathMap.get(frame) || "root";
    const parentFrame = frame.parentFrame();
    const parentPath = parentFrame ? pathMap.get(parentFrame) || "root" : null;
    const offset = await computeFrameOffset(frame);

    try {
      const observation = await Promise.race([
        frame.evaluate(extractPageObservation, config),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("frame_eval_timeout")), evalTimeoutMs);
        }),
      ]);
      frames.push({
        frame_id: framePath,
        parent_frame_id: parentPath,
        url: frame.url() || "",
        title: observation.metadata?.title || "",
        accessible: true,
        cross_origin_blocked: false,
        tree: observation.tree,
        interactive_elements: observation.interactive_elements || [],
        links: observation.links || [],
        document_stats: observation.document_stats || {},
        media: observation.media || {
          iframes: [],
          videos: [],
          audio: [],
          images: [],
          sources: [],
          tracks: [],
        },
      });
      frameRecords.push(
        buildLegacyFrameRecord(
          observation,
          framePath,
          parentPath,
          frame,
          offset,
        ),
      );
    } catch (error) {
      const errorMessage = String(error?.message || "frame_evaluate_failed");
      frames.push({
        frame_id: framePath,
        parent_frame_id: parentPath,
        url: frame.url() || "",
        title: "",
        accessible: false,
        cross_origin_blocked: true,
        tree: null,
        interactive_elements: [],
        links: [],
        document_stats: {},
        media: {
          iframes: [],
          videos: [],
          audio: [],
          images: [],
          sources: [],
          tracks: [],
        },
      });
      frameRecords.push({
        frame_path: framePath,
        parent_frame_path: parentPath,
        depth: frameDepth(framePath),
        is_main_frame: frame === page.mainFrame(),
        name: frame.name?.() || "",
        url: frame.url() || "",
        viewport_offset: offset,
        title: "",
        text_sample: "",
        text_hash: textHash(""),
        total_links: 0,
        total_buttons: 0,
        total_iframes: 0,
        video_count: 0,
        has_server_controls: false,
        has_player_library: false,
        player_libraries_detail: {},
        purpose_hint: "unknown",
        sample_links: [],
        sample_buttons: [],
        links: [],
        buttons: [],
        error: errorMessage,
      });
    }
  }

  return { frames, frameRecords };
}

export function buildInspectResponse({
  config,
  requestedUrl,
  finalUrl,
  pageContext,
  loadState,
  observation,
  frames,
  network,
  dataResponses,
  mutationObservations,
  storage,
  snapshots,
  screenshotUrl,
  pageDigest,
  frameRecords,
}) {
  const title = observation?.metadata?.title || pageContext?.title || "";
  const textSample = pageDigest?.text_sample || "";
  const accessState = detectAccessStateFromSignals({
    title,
    textSample,
    htmlSample: "",
    url: finalUrl,
  });

  const legacy = buildLegacyCompatibilityView(
    observation,
    pageDigest,
    frameRecords,
  );

  return {
    schema_version: OBSERVATION_SCHEMA_VERSION,
    page: {
      requested_url: requestedUrl || finalUrl || "",
      final_url: finalUrl || requestedUrl || "",
      title,
      language: pageContext?.language || "",
      direction: pageContext?.direction || "",
      viewport: pageContext?.viewport || { width: 0, height: 0 },
      timestamp: pageContext?.timestamp || new Date().toISOString(),
    },
    load_state: {
      domcontentloaded: Boolean(loadState?.domcontentloaded),
      load: Boolean(loadState?.load),
      network_idle_reached: Boolean(loadState?.network_idle_reached),
      waited_ms: Number(loadState?.waited_ms || 0),
      console_errors: loadState?.console_errors || [],
      page_errors: loadState?.page_errors || [],
    },
    metadata: observation?.metadata || {},
    document_stats: observation?.document_stats || {},
    outline: observation?.outline || { headings: [], landmarks: [] },
    tree: observation?.tree || null,
    regions: observation?.regions || [],
    repeated_structures: observation?.repeated_structures || [],
    tables: observation?.tables || [],
    links: observation?.links || [],
    interactive_elements: observation?.interactive_elements || [],
    forms: observation?.forms || [],
    media: observation?.media || {
      iframes: [],
      videos: [],
      audio: [],
      images: [],
      sources: [],
      tracks: [],
    },
    frames: frames || [],
    shadow_roots: observation?.shadow_roots || [],
    scripts: observation?.scripts || {
      external: [],
      inline_summaries: [],
      script_url_strings: [],
      script_object_keys: [],
    },
    network: network || { resource_summary: {}, requests: [], responses: [] },
    data_responses: dataResponses || [],
    mutation_observations: mutationObservations || [],
    storage: storage || {
      local_storage_keys: [],
      session_storage_keys: [],
      cookies_summary: [],
    },
    snapshots: snapshots || {
      initial_tree: null,
      after_wait_tree: null,
      after_scroll_tree: null,
      after_interaction_tree: null,
    },
    pruning: observation?.pruning || {},

    url: finalUrl || requestedUrl || "",
    title,
    screenshot_url: screenshotUrl || "",
    contentLinks: legacy.contentLinks,
    navLinks: legacy.navLinks,
    buttons: legacy.buttons,
    iframes: legacy.iframes,
    hosting_signals: legacy.hosting_signals,
    popups: legacy.popups,
    dom_skeleton: legacy.dom_skeleton,
    pagination: legacy.pagination,
    videos: legacy.videos,
    elements: legacy.elements,
    frame_tree: legacy.frame_tree,
    lazy_load_warmup: null,
    page_digest: legacy.page_digest,
    stats: {
      content_links: legacy.contentLinks.length,
      nav_links: legacy.navLinks.length,
      buttons: legacy.buttons.length,
      iframes: legacy.iframes.length,
      videos: legacy.videos.length,
      popups: legacy.popups.length,
      elements: legacy.elements.length,
      frames_total: legacy.frame_tree.length,
      frames_with_video: legacy.frame_tree.filter(
        (frame) => frame.video_count > 0,
      ).length,
      lazy_load_clicks: 0,
      lazy_load_scroll_steps: 0,
    },
    access_state: accessState,
    inspect_config: config,
  };
}

export async function inspect(params = {}) {
  const browserWsEndpoint = params.browserWsEndpoint;
  const config = normalizeInspectConfig(params);

  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const requestedUrl = config.url || page.url();
    const startTime = Date.now();
    const networkRecorder = createNetworkRecorder(page, config, startTime);
    const consoleErrors = [];
    const pageErrors = [];

    const onConsole = (message) => {
      if (message.type() === "error") {
        consoleErrors.push(normalizeWhitespace(message.text()));
      }
    };
    const onPageError = (error) => {
      pageErrors.push(normalizeWhitespace(error?.message || error));
    };

    page.on("console", onConsole);
    page.on("pageerror", onPageError);

    let networkIdleReached = false;
    let initialTree = null;
    let afterWaitTree = null;
    const mutationObservations = [];

    try {
      if (config.url && page.url() !== config.url) {
        await page.goto(config.url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      }

      await installMutationObserver(page);
      initialTree = await extractTreeSnapshot(page, config);

      if (config.wait_ms > 0) {
        if (typeof page.waitForTimeout === "function") {
          await page.waitForTimeout(config.wait_ms).catch(() => {});
        } else {
          await sleep(config.wait_ms);
        }
        await page
          .waitForNetworkIdle({
            idleTime: 500,
            timeout: Math.max(config.wait_ms, 1500),
          })
          .then(() => {
            networkIdleReached = true;
          })
          .catch(() => {
            networkIdleReached = false;
          });
      }

      afterWaitTree = await extractTreeSnapshot(page, config);
      mutationObservations.push(
        await collectMutationSummary(page, "after_wait"),
      );

      const observation = await page.evaluate(extractPageObservation, config);
      const { frames, frameRecords } = await extractFrameObservations(
        page,
        config,
      );
      const storage = await extractStorage(page);
      const network = buildNetworkSummary(
        networkRecorder.requests,
        networkRecorder.responses,
        startTime,
      );
      const dataResponses = buildDataResponses(networkRecorder.responses);
      const screenshotUrl = config.include_screenshot
        ? await screenshotViewport(page).catch(
            (error) => `error: ${error.message}`,
          )
        : "";
      const pageContext = await page
        .evaluate(() => ({
          language: document.documentElement.lang || "",
          direction: document.documentElement.dir || "ltr",
          viewport: {
            width: window.innerWidth || 0,
            height: window.innerHeight || 0,
          },
          readyState: document.readyState || "unknown",
          title: document.title || "",
        }))
        .catch(() => ({
          language: "",
          direction: "ltr",
          viewport: { width: 0, height: 0 },
          readyState: "unknown",
          title: "",
        }));
      const pageDigest = await page
        .evaluate(() => {
          const normalizeText = (value) =>
            String(value ?? "")
              .replace(/\s+/g, " ")
              .trim();
          return {
            text_sample: normalizeText(
              document.body?.innerText ||
                document.documentElement?.innerText ||
                "",
            ),
            html_size: (document.documentElement?.outerHTML || "").length,
            node_count: document.querySelectorAll("*").length,
          };
        })
        .catch(() => ({
          text_sample: "",
          html_size: 0,
          node_count: 0,
        }));

      return buildInspectResponse({
        config,
        requestedUrl,
        finalUrl: page.url(),
        pageContext: {
          ...pageContext,
          timestamp: new Date().toISOString(),
        },
        loadState: {
          domcontentloaded: ["interactive", "complete"].includes(
            pageContext.readyState,
          ),
          load: pageContext.readyState === "complete",
          network_idle_reached: networkIdleReached,
          waited_ms: config.wait_ms,
          console_errors: consoleErrors,
          page_errors: pageErrors,
        },
        observation,
        frames,
        network,
        dataResponses,
        mutationObservations,
        storage,
        snapshots: {
          initial_tree: initialTree,
          after_wait_tree: afterWaitTree,
          after_scroll_tree: null,
          after_interaction_tree: null,
        },
        screenshotUrl,
        pageDigest,
        frameRecords,
      });
    } catch (error) {
      return {
        schema_version: OBSERVATION_SCHEMA_VERSION,
        page: {
          requested_url: requestedUrl,
          final_url: page.url(),
        },
        error: {
          type: "inspect_failed",
          message: normalizeWhitespace(error?.message || error),
          phase: "inspect",
        },
        partial_observation: {
          snapshots: {
            initial_tree: initialTree,
            after_wait_tree: afterWaitTree,
            after_scroll_tree: null,
            after_interaction_tree: null,
          },
          mutation_observations: mutationObservations,
        },
      };
    } finally {
      networkRecorder.dispose();
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    }
  });
}
