import {
  augmentElements,
  buildEnvelope,
  buildFrameState,
  buildFrameTree,
  collectElements,
  filterElements,
  getMediaSummary,
  readElementDetail,
  resolveElementTarget,
  withBrowserSession,
} from "../shared/tool-runtime.js";

function summarizeKinds(elements) {
  const counts = {};
  for (const element of elements) {
    counts[element.kind] = (counts[element.kind] || 0) + 1;
  }
  return counts;
}

function compactElements(elements, limit = 8) {
  return elements.slice(0, limit).map((element) => ({
    kind: element.kind,
    text: element.text,
    href: element.href,
    src: element.src,
    selector: element.selector,
    xpath: element.xpath,
    frame_path: element.frame_path,
    geometry: element.geometry,
    element_ref: element.element_ref,
  }));
}

function summarizeDedupedLinks(elements, limit = 60) {
  const buckets = new Map();
  for (const element of elements) {
    if (element.kind !== "link" || !element.href) continue;
    const href = String(element.href).trim();
    if (!href) continue;
    const key = href;
    if (!buckets.has(key)) {
      buckets.set(key, {
        href,
        occurrences: 0,
        visible_occurrences: 0,
        sample_texts: [],
      });
    }
    const row = buckets.get(key);
    row.occurrences += 1;
    if (element.visible) row.visible_occurrences += 1;
    if (
      element.text &&
      row.sample_texts.length < 3 &&
      !row.sample_texts.includes(element.text)
    ) {
      row.sample_texts.push(element.text);
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, limit);
}

function suggestRevealActions(elements) {
  const revealPatterns =
    /(show more|load more|see more|more servers|next|older|expand|view all|watch now|play)/i;
  const candidates = elements.filter(
    (element) =>
      ["button", "tab", "link"].includes(element.kind) &&
      revealPatterns.test(String(element.text || "")),
  );

  return compactElements(candidates, 12);
}

function summarizePagination(elements) {
  const paginationMatches = elements.filter(
    (element) =>
      element.kind === "link" &&
      (/next|prev|page|\d+/.test((element.text || "").toLowerCase()) ||
        /pagination|page/.test(element.selector || "")),
  );

  return {
    detected: paginationMatches.length > 0,
    candidates: compactElements(paginationMatches, 6),
  };
}

function summarizeForms(elements) {
  const forms = elements.filter((element) => element.kind === "form");
  const inputs = elements.filter((element) =>
    ["input", "checkbox", "radio", "select"].includes(element.kind),
  );
  return {
    form_count: forms.length,
    input_count: inputs.length,
    top_forms: compactElements(forms, 4),
    top_inputs: compactElements(inputs, 6),
  };
}

function normalizeLimit(limit, fallback = 20, max = 240) {
  const parsed = Number.parseInt(String(limit), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function dedupeByElementRef(elements) {
  const seen = new Set();
  const output = [];
  for (const element of elements) {
    if (!element?.element_ref || seen.has(element.element_ref)) continue;
    seen.add(element.element_ref);
    output.push(element);
  }
  return output;
}

function toSafeRegex(pattern) {
  if (!pattern) {
    return null;
  }
  if (pattern instanceof RegExp) {
    return pattern;
  }
  try {
    return new RegExp(String(pattern), "i");
  } catch {
    return null;
  }
}

function tokenizeNeedle(value) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12);
}

function scoreElementForQuery(
  element,
  {
    kind,
    text_contains,
    text_regex,
    href_contains,
    href_regex,
    attr_name,
    attr_value_contains,
    attr_value_regex,
  },
) {
  let score = 0;
  const text = String(element.text || "").toLowerCase();
  const nearby = String(element.nearby_text || "").toLowerCase();
  const href = String(element.href || "").toLowerCase();
  const textRegex = toSafeRegex(text_regex);
  const hrefRegex = toSafeRegex(href_regex);
  const attrValueRegex = toSafeRegex(attr_value_regex);

  if (kind && element.kind === kind) score += 6;

  if (text_contains) {
    const needle = String(text_contains).toLowerCase();
    if (text.includes(needle)) score += 10;
    else if (nearby.includes(needle)) score += 6;

    const tokens = tokenizeNeedle(needle);
    for (const token of tokens) {
      if (text.includes(token)) score += 2;
      else if (nearby.includes(token)) score += 1;
    }
  }

  if (href_contains && href.includes(String(href_contains).toLowerCase())) {
    score += 8;
  }
  if (hrefRegex && hrefRegex.test(String(element.href || ""))) {
    score += 8;
  }

  if (textRegex) {
    const textMatch = textRegex.test(String(element.text || ""));
    const nearbyMatch = textRegex.test(String(element.nearby_text || ""));
    if (textMatch) {
      score += 10;
    } else if (nearbyMatch) {
      score += 5;
    }
  }

  if (attr_name) {
    const attrValue = String(element.attrs?.[attr_name] || "").toLowerCase();
    if (attrValue) score += 3;
    if (
      attr_value_contains &&
      attrValue.includes(String(attr_value_contains).toLowerCase())
    ) {
      score += 5;
    }
    if (attrValueRegex && attrValueRegex.test(String(element.attrs?.[attr_name] || ""))) {
      score += 5;
    }
  }

  if (element.visible) score += 3;
  if (
    element.kind === "button" ||
    element.kind === "link" ||
    element.kind === "tab"
  )
    score += 2;

  return score;
}

function rankMatches(elements, query) {
  return [...elements]
    .map((element) => ({
      element,
      score: scoreElementForQuery(element, query),
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.element);
}

function tokenFallbackMatches(
  elements,
  { kind, text_contains, href_contains, attr_name, attr_value_contains },
) {
  const tokens = tokenizeNeedle(text_contains);
  if (!tokens.length) return [];

  const normalizedHref = String(href_contains || "").toLowerCase();
  const normalizedAttrValue = String(attr_value_contains || "").toLowerCase();

  return elements.filter((element) => {
    if (kind && element.kind !== kind) return false;

    const textHaystack = `${String(element.text || "").toLowerCase()} ${String(
      element.nearby_text || "",
    ).toLowerCase()}`;
    const tokenHit = tokens.some((token) => textHaystack.includes(token));
    if (!tokenHit) return false;

    if (
      normalizedHref &&
      !String(element.href || "").toLowerCase().includes(normalizedHref)
    ) {
      return false;
    }

    if (attr_name) {
      const attrValue = String(element.attrs?.[attr_name] || "").toLowerCase();
      if (!attrValue) return false;
      if (normalizedAttrValue && !attrValue.includes(normalizedAttrValue)) {
        return false;
      }
    }

    return true;
  });
}

export function hasSpecificQuery({
  text_contains = "",
  text_regex = "",
  href_contains = "",
  href_regex = "",
  attr = null,
  attr_name = "",
  attr_value_contains = "",
  attr_value_regex = "",
  scope_node_id = "",
  scope_element_ref = "",
  scope_selector = "",
  scope_xpath = "",
  scope_text = "",
} = {}) {
  const hasAttr = Boolean(
    attr?.name ||
      attr_name ||
      attr?.value_contains ||
      attr_value_contains ||
      attr?.value_regex ||
      attr_value_regex,
  );
  const hasScope = Boolean(
    scope_node_id || scope_element_ref || scope_selector || scope_xpath || scope_text,
  );
  return Boolean(
    text_contains ||
      text_regex ||
      href_contains ||
      href_regex ||
      hasAttr ||
      hasScope,
  );
}

export function querySpecificity(args = {}) {
  let score = 0;
  for (const key of [
    "text_contains",
    "text_regex",
    "href_contains",
    "href_regex",
    "attr_name",
    "attr_value_contains",
    "attr_value_regex",
  ]) {
    if (String(args[key] || "").trim()) score += 1;
  }
  if (args.attr?.name) score += 1;
  if (args.attr?.value_contains || args.attr?.value_regex) score += 1;
  for (const key of [
    "scope_node_id",
    "scope_element_ref",
    "scope_selector",
    "scope_xpath",
    "scope_text",
  ]) {
    if (String(args[key] || "").trim()) score += 2;
  }
  return score;
}

function scopeLocator({ scope_element_ref, scope_selector, scope_xpath, scope_text } = {}) {
  return {
    element_ref: scope_element_ref || "",
    selector: scope_selector || "",
    xpath: scope_xpath || "",
    text: scope_text || "",
  };
}

export function matchesScopeXpath(element, scopeXpath) {
  const elementXpath = String(element.xpath || "");
  const normalizedScope = String(scopeXpath || "").replace(/\/$/, "");
  return Boolean(
    normalizedScope &&
      (elementXpath === normalizedScope || elementXpath.startsWith(`${normalizedScope}/`)),
  );
}

async function collectElementsUnderHandle(handle, framePath = "root") {
  return handle.evaluate((root, { framePathValue }) => {
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

    const getXpath = (node) => {
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
    };

    const inferKind = (node) => {
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
      if (classes.includes("overlay") || classes.includes("modal") || classes.includes("popup")) return "overlay";
      if (tag === "a" && node.getAttribute("href")) return "link";
      if (tag === "button" || role === "button" || node.getAttribute("onclick")) return "button";
      return "element";
    };

    const getSelector = (node, index) => {
      if (node.id) return `#${node.id}`;
      const name = node.getAttribute("name");
      if (name) return `[name="${name}"]`;
      const classes = (node.className || "").toString().trim().split(/\s+/).filter(Boolean);
      if (classes.length > 0) return `.${classes.slice(0, 2).join(".")}`;
      return `${node.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
    };

    const selector =
      'a[href],button,input,textarea,select,video,iframe,form,[role="button"],[role="tab"],[onclick],[class*="tab"],[class*="overlay"],[class*="modal"],[class*="popup"]';
    const nodes = [
      ...(root.matches?.(selector) ? [root] : []),
      ...Array.from(root.querySelectorAll(selector)),
    ];

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
      return {
        kind: inferKind(node),
        tag: node.tagName.toLowerCase(),
        type: (node.getAttribute("type") || "").toLowerCase(),
        role: (node.getAttribute("role") || "").toLowerCase(),
        text,
        href: node.getAttribute("href") || "",
        src: node.getAttribute("src") || "",
        selector: getSelector(node, index),
        xpath: getXpath(node),
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
  }, { framePathValue: framePath });
}

export async function getPageContext({ frame_path = "root", browserWsEndpoint } = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frameState = await buildFrameState(page, frame_path);
    if (!frameState.ok) {
      return buildEnvelope(page, {
        frame_path,
        ok: false,
        error: frameState.error,
        data: { frame_tree: await buildFrameTree(page) },
      });
    }

    const rawElements = await collectElements(frameState.frame, frame_path);
    const elements = augmentElements(rawElements, frameState);
    const frameTree = await buildFrameTree(page);
    const media = await getMediaSummary(frameState.frame);

    const links = elements.filter((element) => element.kind === "link");
    const buttons = elements.filter((element) =>
      ["button", "tab"].includes(element.kind),
    );
    const hiddenInteractive = elements.filter(
      (element) =>
        !element.visible && ["link", "button", "tab"].includes(element.kind),
    );
    const overlays = elements.filter((element) => element.kind === "overlay");
    const videos = elements.filter((element) => element.kind === "video");
    const iframes = frameTree.filter(
      (frame) =>
        frame.frame_path !== frame_path &&
        (frame_path === "root" || frame.frame_path.startsWith(`${frame_path}.`)),
    );

    return buildEnvelope(page, {
      frame_path,
      data: {
        frame_tree: frameTree,
        page_summary: {
          counts_by_kind: summarizeKinds(elements),
          links: links.length,
          buttons: buttons.length,
          overlays: overlays.length,
          videos: videos.length,
          iframes: frameTree.length - 1,
        },
        pagination: summarizePagination(elements),
        forms: summarizeForms(elements),
        player_media_signals: {
          ...media,
          has_video: media.video_count > 0,
          has_player_library: Object.values(media.player_libraries || {}).some(Boolean),
          has_iframe_player_hint: iframes.some(
            (frame) => frame.candidate_purpose === "player",
          ),
        },
        top_links: compactElements(links, 8),
        top_buttons: compactElements(buttons, 8),
        hidden_interactive_candidates: compactElements(hiddenInteractive, 10),
        deduped_links: summarizeDedupedLinks(elements, 80),
        reveal_actions: suggestRevealActions(elements),
        top_overlays: compactElements(overlays, 5),
        top_candidates: compactElements(
          elements.filter((element) =>
            ["link", "button", "tab", "video", "overlay", "iframe"].includes(
              element.kind,
            ),
          ),
          30,
        ),
      },
    });
  });
}

export async function queryElements({
  frame_path = "root",
  kind = "",
  text_contains = "",
  text_regex = "",
  href_contains = "",
  href_regex = "",
  attr = null,
  attr_name = "",
  attr_value_contains = "",
  attr_value_regex = "",
  scope_node_id = "",
  scope_element_ref = "",
  scope_selector = "",
  scope_xpath = "",
  scope_text = "",
  visible_only = true,
  limit = 20,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frameState = await buildFrameState(page, frame_path);
    if (!frameState.ok) {
      return buildEnvelope(page, {
        frame_path,
        ok: false,
        error: frameState.error,
      });
    }

    const rawElements = await collectElements(frameState.frame, frame_path);
    let elements = augmentElements(rawElements, frameState);
    const normalizedLimit = normalizeLimit(limit);
    const normalizedAttr =
      attr ||
      (attr_name
        ? {
            name: attr_name,
            value_contains: attr_value_contains,
            value_regex: attr_value_regex,
          }
        : null);
    const effectiveAttrName = String(normalizedAttr?.name || attr_name || "");
    const effectiveAttrValueContains = String(
      normalizedAttr?.value_contains || attr_value_contains || "",
    );
    const effectiveAttrValueRegex = String(
      normalizedAttr?.value_regex || attr_value_regex || "",
    );
    const allLimit = Math.max(elements.length, 1);
    const fallback_notes = [];
    const specificity = querySpecificity({
      text_contains,
      text_regex,
      href_contains,
      href_regex,
      attr,
      attr_name,
      attr_value_contains,
      attr_value_regex,
      scope_node_id,
      scope_element_ref,
      scope_selector,
      scope_xpath,
      scope_text,
    });
    const specificQuery = hasSpecificQuery({
      text_contains,
      text_regex,
      href_contains,
      href_regex,
      attr,
      attr_name,
      attr_value_contains,
      attr_value_regex,
      scope_node_id,
      scope_element_ref,
      scope_selector,
      scope_xpath,
      scope_text,
    });
    const scopeRequested = Boolean(
      scope_node_id || scope_element_ref || scope_selector || scope_xpath || scope_text,
    );
    let scopeApplied = false;
    let scopeMetadata = {};

    if (scope_element_ref || scope_selector || scope_xpath || scope_text) {
      const resolvedScope = await resolveElementTarget(page, {
        frame_path,
        ...scopeLocator({ scope_element_ref, scope_selector, scope_xpath, scope_text }),
      });
      if (resolvedScope.ok) {
        const scopedState = await buildFrameState(page, resolvedScope.frame_path);
        const scopedRawElements = await collectElementsUnderHandle(
          resolvedScope.handle,
          resolvedScope.frame_path,
        );
        await resolvedScope.handle.dispose().catch(() => {});
        elements = augmentElements(scopedRawElements, scopedState);
        scopeApplied = true;
        scopeMetadata = {
          frame_path: resolvedScope.frame_path,
          locator_used: resolvedScope.locator_used || {},
          frame_relocated: Boolean(resolvedScope.frame_relocated),
        };
      } else {
        fallback_notes.push(`Scope could not be resolved: ${resolvedScope.error}`);
        scopeMetadata = {
          error: resolvedScope.error,
          error_code: resolvedScope.code || "scope_resolution_failed",
        };
      }
    } else if (scope_node_id) {
      fallback_notes.push(
        "scope_node_id requires a current context-tree node handle; use scope_element_ref, scope_selector, or scope_xpath when possible.",
      );
      scopeMetadata = { node_id: scope_node_id, supported: false };
    }

    if (scope_xpath && !scopeApplied) {
      const scopedByXpath = elements.filter((element) => matchesScopeXpath(element, scope_xpath));
      if (scopedByXpath.length) {
        elements = scopedByXpath;
        scopeApplied = true;
        scopeMetadata = { xpath: scope_xpath, matched_by: "element_xpath_prefix" };
      }
    }

    if (scope_node_id && !scopeApplied && !scope_element_ref && !scope_selector && !scope_xpath && !scope_text) {
      return buildEnvelope(page, {
        frame_path,
        warnings: [
          "query_elements could not apply scope_node_id by itself; pass the node's element_ref, selector, or xpath for subtree scoping.",
        ],
        data: {
          query: {
            kind,
            text_contains,
            text_regex,
            href_contains,
            href_regex,
            attr: normalizedAttr,
            attr_name: effectiveAttrName,
            attr_value_contains: effectiveAttrValueContains,
            attr_value_regex: effectiveAttrValueRegex,
            scope_node_id,
            scope_element_ref,
            scope_selector,
            scope_xpath,
            scope_text,
            visible_only,
            limit: normalizedLimit,
          },
          search_strategy: "scope_unresolved",
          query_specificity: specificity,
          scope_requested: scopeRequested,
          scope_applied: false,
          scope: scopeMetadata,
          total_matches: 0,
          returned_matches: 0,
          fallback_notes,
          available_counts: {
            total_elements: elements.length,
            by_kind: summarizeKinds(elements),
          },
          matches: [],
          suggestions: [],
          recommended_next_tool:
            "get_element_detail with the context node element_ref, or query_elements with scope_element_ref/scope_selector/scope_xpath",
        },
      });
    }

    if (!specificQuery) {
      const suggestions = compactElements(
        rankMatches(
          dedupeByElementRef(
            elements.filter((element) => !kind || element.kind === kind),
          ),
          { kind },
        ),
        Math.min(12, normalizedLimit),
      );

      return buildEnvelope(page, {
        frame_path,
        warnings: [
          "query_elements was underspecified; provide text/href/attr predicates or a scope before using it as a precision tool.",
        ],
        data: {
          query: {
            kind,
            text_contains,
            text_regex,
            href_contains,
            href_regex,
            attr: normalizedAttr,
            attr_name: effectiveAttrName,
            attr_value_contains: effectiveAttrValueContains,
            attr_value_regex: effectiveAttrValueRegex,
            scope_node_id,
            scope_element_ref,
            scope_selector,
            scope_xpath,
            scope_text,
            visible_only,
            limit: normalizedLimit,
          },
          search_strategy: "underspecified",
          query_specificity: specificity,
          scope_requested: scopeRequested,
          scope_applied: scopeApplied,
          scope: scopeMetadata,
          total_matches: 0,
          returned_matches: 0,
          fallback_notes: [
            ...fallback_notes,
            "Bare kind/limit queries duplicate broad context; use inspect_landing or get_page_context for broad reads.",
          ],
          available_counts: {
            total_elements: elements.length,
            by_kind: summarizeKinds(elements),
          },
          matches: [],
          suggestions,
          recommended_next_tool:
            suggestions.length > 0
              ? "get_element_detail with a suggested element_ref, or query_elements again with text/href/scope predicates"
              : "inspect_landing or get_page_context",
        },
      });
    }

    const textRegex = toSafeRegex(text_regex);
    if (text_regex && !textRegex) {
      fallback_notes.push(`Ignored invalid text_regex pattern: ${text_regex}`);
    }
    const hrefRegex = toSafeRegex(href_regex);
    if (href_regex && !hrefRegex) {
      fallback_notes.push(`Ignored invalid href_regex pattern: ${href_regex}`);
    }
    const attrValueRegex = toSafeRegex(effectiveAttrValueRegex);
    if (effectiveAttrValueRegex && !attrValueRegex) {
      fallback_notes.push(
        `Ignored invalid attr_value_regex pattern: ${effectiveAttrValueRegex}`,
      );
    }

    const primaryMatches = filterElements(elements, {
      kind,
      text_contains,
      text_regex: textRegex,
      href_contains,
      href_regex: hrefRegex,
      attr: normalizedAttr,
      attr_name: effectiveAttrName,
      attr_value_contains: effectiveAttrValueContains,
      attr_value_regex: attrValueRegex,
      visible_only,
      limit: allLimit,
    });

    let strategy = "strict";
    let matchesAll = primaryMatches;

    if (!matchesAll.length && visible_only) {
      const relaxedVisibilityMatches = filterElements(elements, {
        kind,
        text_contains,
        text_regex: textRegex,
        href_contains,
        href_regex: hrefRegex,
        attr: normalizedAttr,
        attr_name: effectiveAttrName,
        attr_value_contains: effectiveAttrValueContains,
        attr_value_regex: attrValueRegex,
        visible_only: false,
        limit: allLimit,
      });

      if (relaxedVisibilityMatches.length) {
        matchesAll = relaxedVisibilityMatches;
        strategy = "relaxed_visibility";
        fallback_notes.push("No visible matches; included hidden candidates.");
      }
    }

    if (!matchesAll.length && text_contains) {
      const tokenMatches = tokenFallbackMatches(elements, {
        kind,
        text_contains,
        href_contains,
        attr_name: effectiveAttrName,
        attr_value_contains: effectiveAttrValueContains,
      });
      if (tokenMatches.length) {
        matchesAll = tokenMatches;
        strategy = "token_text_fallback";
        fallback_notes.push(
          "Strict text matching returned no results; token fallback used.",
        );
      }
    }

    const rankedMatches = rankMatches(dedupeByElementRef(matchesAll), {
      kind,
      text_contains,
      text_regex: textRegex,
      href_contains,
      href_regex: hrefRegex,
      attr_name: effectiveAttrName,
      attr_value_contains: effectiveAttrValueContains,
      attr_value_regex: effectiveAttrValueRegex,
    });
    const returnedMatches = rankedMatches.slice(0, normalizedLimit);

    const suggestions = compactElements(
      rankMatches(
        dedupeByElementRef(
          elements.filter((element) => !kind || element.kind === kind),
        ),
        {
          kind,
          text_contains,
          text_regex: textRegex,
          href_contains,
          href_regex: hrefRegex,
          attr_name: effectiveAttrName,
          attr_value_contains: effectiveAttrValueContains,
          attr_value_regex: effectiveAttrValueRegex,
        },
      ),
      Math.min(12, normalizedLimit),
    );

    return buildEnvelope(page, {
      frame_path,
      data: {
        query: {
          kind,
          text_contains,
          text_regex,
          href_contains,
          href_regex,
          attr: normalizedAttr,
          attr_name: effectiveAttrName,
          attr_value_contains: effectiveAttrValueContains,
          visible_only,
          limit: normalizedLimit,
          attr_value_regex: effectiveAttrValueRegex,
          scope_node_id,
          scope_element_ref,
          scope_selector,
          scope_xpath,
          scope_text,
        },
        search_strategy: strategy,
        query_specificity: specificity,
        scope_requested: scopeRequested,
        scope_applied: scopeApplied,
        scope: scopeMetadata,
        total_matches: rankedMatches.length,
        returned_matches: returnedMatches.length,
        fallback_notes,
        available_counts: {
          total_elements: elements.length,
          by_kind: summarizeKinds(elements),
        },
        matches: compactElements(returnedMatches, normalizedLimit),
        suggestions: rankedMatches.length ? [] : suggestions,
        recommended_next_tool: rankedMatches.length
          ? "interact, navigate, or get_element_detail using the returned element_ref/selector/xpath"
          : "get_page_context, inspect_landing, or a more specific query_elements call",
      },
    });
  });
}

export async function getElementDetail({
  frame_path = "root",
  element_ref = "",
  selector = "",
  xpath = "",
  text = "",
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const detail = await readElementDetail(page, {
      frame_path,
      element_ref,
      selector,
      xpath,
      text,
    });
    if (!detail.ok) {
      return buildEnvelope(page, {
        frame_path: detail.frame_path || frame_path,
        ok: false,
        error: detail.error,
        data: {
          error_code: detail.code || "element_detail_failed",
          stale_ref_detected: Boolean(detail.stale_ref_detected),
          frame_fallback_applied: Boolean(detail.frame_fallback_applied),
          resolution_attempts: detail.resolution_attempts || [],
        },
      });
    }

    return buildEnvelope(page, {
      frame_path: detail.frame_path,
      screenshot: detail.screenshot,
      screenshotMode: "element",
      data: {
        detail: detail.detail,
        locator_used: detail.locator_used || {},
        stale_ref_detected: Boolean(detail.stale_ref_detected),
        frame_fallback_applied: Boolean(detail.frame_fallback_applied),
        frame_relocated: Boolean(detail.frame_relocated),
        resolution_attempts: detail.resolution_attempts || [],
      },
    });
  });
}

export async function getMediaState({ frame_path = "root", browserWsEndpoint } = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frameState = await buildFrameState(page, frame_path);
    if (!frameState.ok) {
      return buildEnvelope(page, { frame_path, ok: false, error: frameState.error });
    }

    const mediaState = await getMediaSummary(frameState.frame);
    const videos = Array.isArray(mediaState.videos) ? mediaState.videos : [];
    const playbackStarted = videos.some(
      (video) =>
        (!video.paused &&
          (Number(video.ready_state || 0) >= 2 ||
            Number(video.current_time || 0) > 0)) ||
        Number(video.current_time || 0) > 0,
    );
    const playbackReady = videos.some(
      (video) => Number(video.ready_state || 0) >= 2,
    );

    return buildEnvelope(page, {
      frame_path,
      data: {
        media_state: mediaState,
        playback_ready: playbackReady,
        playback_started: playbackStarted,
        verification_basis: {
          video_count: videos.length,
          requires_current_time_or_playing_event: true,
          ready_state_threshold: 2,
        },
      },
    });
  });
}

export async function getFrameTree({ browserWsEndpoint } = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) =>
    buildEnvelope(page, {
      frame_path: "root",
      data: {
        frame_tree: await buildFrameTree(page),
      },
    }));
}
