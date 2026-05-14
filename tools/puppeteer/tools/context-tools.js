import {
  buildEnvelope,
  buildFrameState,
  buildFrameTree,
  getMediaSummary,
  readElementDetail,
  withBrowserSession,
} from '../shared/tool-runtime.js';
import {
  buildFrameCatalog,
  buildNormalizedTreeArtifacts,
  compactActionTargets,
  compactContextTree,
  compactFrameCatalog,
  compactNodeIndex,
  findNodeById,
  summarizeNodeKinds,
  summarizeScopedCollections,
} from './context-tree.js';
import { extractPageObservation } from './inspect.js';

function normalizeLimit(limit, fallback = 20, max = 200) {
  const parsed = Number.parseInt(String(limit), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function compactNodes(nodes, limit = 8) {
  return nodes.slice(0, limit).map((node) => ({
    node_id: node.node_id,
    semantic_kind: node.semantic_kind,
    tag: node.tag,
    name: node.name,
    text_preview: node.text_preview,
    href: node.href || '',
    src: node.src || '',
    selector: node.selector,
    xpath: node.xpath,
    frame_path: node.frame_path,
    bbox: node.bbox,
    element_ref: node.element_ref,
    visible: Boolean(node.visible),
    counts: node.counts || {},
  }));
}

function summarizeDedupedLinks(nodes, limit = 60) {
  const buckets = new Map();
  for (const node of nodes) {
    if (node.semantic_kind !== 'link') continue;
    const href = String(node.href || '').trim();
    if (!href) continue;
    if (!buckets.has(href)) {
      buckets.set(href, {
        href,
        occurrences: 0,
        visible_occurrences: 0,
        sample_texts: [],
      });
    }
    const row = buckets.get(href);
    row.occurrences += 1;
    if (node.visible) row.visible_occurrences += 1;
    if (node.text_preview && row.sample_texts.length < 3 && !row.sample_texts.includes(node.text_preview)) {
      row.sample_texts.push(node.text_preview);
    }
  }
  return Array.from(buckets.values()).sort((a, b) => b.occurrences - a.occurrences).slice(0, limit);
}

function summarizePagination(nodes) {
  const matches = nodes.filter((node) =>
    ['link', 'button', 'tab'].includes(node.semantic_kind)
    && /next|prev|page|older|newer|\b\d+\b/i.test(`${node.text_preview || ''} ${node.selector || ''}`));
  return {
    detected: matches.length > 0,
    candidates: compactNodes(matches, 6),
  };
}

function summarizeForms(nodes) {
  const forms = nodes.filter((node) => node.tag === 'form' || node.semantic_kind === 'region');
  const inputs = nodes.filter((node) => ['input', 'select', 'checkbox', 'radio'].includes(node.semantic_kind));
  return {
    form_count: forms.filter((node) => node.tag === 'form').length,
    input_count: inputs.length,
    top_forms: compactNodes(forms, 4),
    top_inputs: compactNodes(inputs, 6),
  };
}

function tokenizeNeedle(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12);
}

function toSafeRegex(pattern) {
  if (!pattern) return null;
  if (pattern instanceof RegExp) return pattern;
  try {
    return new RegExp(String(pattern), 'i');
  } catch {
    return null;
  }
}

function kindMatches(node, kind) {
  if (!kind) return true;
  return node.semantic_kind === kind || node.tag === kind;
}

function scoreNodeForQuery(node, {
  kind,
  text_contains,
  text_regex,
  href_contains,
  href_regex,
  attr_name,
  attr_value_contains,
  attr_value_regex,
}) {
  let score = 0;
  const text = String(node.text_preview || '').toLowerCase();
  const name = String(node.name || '').toLowerCase();
  const href = String(node.href || node.src || '').toLowerCase();
  const textRegex = toSafeRegex(text_regex);
  const hrefRegex = toSafeRegex(href_regex);
  const attrValueRegex = toSafeRegex(attr_value_regex);

  if (kindMatches(node, kind)) score += 6;

  if (text_contains) {
    const needle = String(text_contains).toLowerCase();
    if (text.includes(needle)) score += 10;
    else if (name.includes(needle)) score += 6;
    for (const token of tokenizeNeedle(needle)) {
      if (text.includes(token) || name.includes(token)) score += 2;
    }
  }

  if (href_contains && href.includes(String(href_contains).toLowerCase())) score += 8;
  if (hrefRegex && hrefRegex.test(String(node.href || node.src || ''))) score += 8;

  if (textRegex) {
    if (textRegex.test(String(node.text_preview || ''))) score += 10;
    else if (textRegex.test(String(node.name || ''))) score += 5;
  }

  if (attr_name) {
    const attrValue = String(node.attributes?.[attr_name] || '').toLowerCase();
    if (attrValue) score += 3;
    if (attr_value_contains && attrValue.includes(String(attr_value_contains).toLowerCase())) score += 5;
    if (attrValueRegex && attrValueRegex.test(String(node.attributes?.[attr_name] || ''))) score += 5;
  }

  if (node.visible) score += 3;
  if (node.semantic_kind === 'button' || node.semantic_kind === 'link' || node.semantic_kind === 'tab') score += 2;
  return score;
}

function rankMatches(nodes, query) {
  return [...nodes]
    .map((node) => ({ node, score: scoreNodeForQuery(node, query) }))
    .filter((entry) => entry.score > 0 || !query.kind)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.node);
}

function dedupeByElementRef(nodes) {
  const seen = new Set();
  const output = [];
  for (const node of nodes) {
    if (!node?.element_ref || seen.has(node.element_ref)) continue;
    seen.add(node.element_ref);
    output.push(node);
  }
  return output;
}

async function buildNormalizedFrameObservation(frame, frameState, config = {}) {
  const observation = await frame.evaluate(extractPageObservation, {
    max_depth: config.max_depth ?? 5,
    max_children_per_node: config.max_children_per_node ?? 35,
    max_links: config.max_links ?? 160,
    max_interactive_elements: config.max_interactive_elements ?? 160,
    max_tables: config.max_tables ?? 20,
    max_table_rows: config.max_table_rows ?? 30,
    max_table_cells: config.max_table_cells ?? 12,
    max_iframes: config.max_iframes ?? 20,
    max_videos: config.max_videos ?? 12,
    max_audio: config.max_audio ?? 12,
    max_images: config.max_images ?? 60,
    max_sources: config.max_sources ?? 60,
    max_tracks: config.max_tracks ?? 40,
    max_forms: config.max_forms ?? 16,
    max_form_inputs: config.max_form_inputs ?? 20,
    include_shadow_dom: config.include_shadow_dom ?? true,
    treeOnly: false,
  });

  const normalized = buildNormalizedTreeArtifacts(observation.tree, {
    frame_path: frameState.frame_path,
    dom_epoch: frameState.dom_epoch,
    page_state_id: frameState.page_state_id,
  });

  return { observation, normalized };
}

async function resolveScopeNode(page, frame_path, node_id) {
  const frameState = await buildFrameState(page, frame_path);
  if (!frameState.ok) {
    return { ok: false, error: frameState.error, frame_path };
  }
  const { normalized } = await buildNormalizedFrameObservation(frameState.frame, frameState, {
    max_depth: 6,
    max_children_per_node: 45,
  });
  const node = findNodeById(normalized.node_index, node_id);
  if (!node) {
    return { ok: false, error: `Could not find node_id '${node_id}' in frame '${frame_path}'`, frame_path };
  }
  return { ok: true, node };
}

async function scopedNodeIndexFromDetail(page, {
  frame_path = 'root',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  max_subtree_depth = 6,
  max_children_per_node = 60,
}) {
  const detail = await readElementDetail(page, {
    frame_path,
    element_ref,
    selector,
    xpath,
    text,
    include_html: false,
    max_subtree_depth,
    max_children_per_node,
  });
  if (!detail.ok) return detail;
  const subtree = detail.detail?.subtree || null;
  if (!subtree) {
    return {
      ok: true,
      frame_path: detail.frame_path,
      page_state_id: detail.page_state_id,
      dom_epoch: detail.dom_epoch,
      node_index: [],
      detail,
    };
  }
  const normalized = buildNormalizedTreeArtifacts(subtree, {
    frame_path: detail.frame_path,
    dom_epoch: detail.dom_epoch,
    page_state_id: detail.page_state_id,
  });
  return {
    ok: true,
    frame_path: detail.frame_path,
    page_state_id: detail.page_state_id,
    dom_epoch: detail.dom_epoch,
    node_index: normalized.node_index,
    context_tree: normalized.context_tree,
    detail,
  };
}

export async function getPageContext({
  frame_path = 'root',
  browserWsEndpoint,
} = {}) {
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

    const { normalized } = await buildNormalizedFrameObservation(frameState.frame, frameState);
    const frame_tree = await buildFrameTree(page);
    const frame_catalog = buildFrameCatalog(frame_tree);
    const media = await getMediaSummary(frameState.frame);
    const links = normalized.node_index.filter((node) => node.semantic_kind === 'link');
    const buttons = normalized.node_index.filter((node) => ['button', 'tab'].includes(node.semantic_kind));
    const overlays = normalized.node_index.filter((node) =>
      ['region', 'container'].includes(node.semantic_kind)
      && /(overlay|modal|popup)/i.test(`${node.name || ''} ${node.selector || ''}`));

    return buildEnvelope(page, {
      frame_path,
      data: {
        context_tree: compactContextTree(normalized.context_tree, {
          maxDepth: 3,
          maxChildrenPerNode: 6,
          textLimit: 60,
        }),
        node_index: compactNodeIndex(normalized.node_index, {
          limit: 24,
          textLimit: 60,
        }),
        action_targets: compactActionTargets(normalized.action_targets, {
          limit: 12,
          textLimit: 60,
        }),
        frame_catalog: compactFrameCatalog(frame_catalog, { limit: 8 }),
        frame_tree_summary: {
          total_frames: frame_tree.length,
          accessible_frames: frame_catalog.filter((frame) => frame.accessible).length,
          player_like_frames: frame_catalog.filter((frame) => frame.purpose_hint === 'player').length,
        },
        page_summary: {
          counts_by_kind: summarizeNodeKinds(normalized.node_index),
          links: links.length,
          buttons: buttons.length,
          overlays: overlays.length,
          videos: media.video_count,
          iframes: frame_tree.length - 1,
        },
        pagination: summarizePagination(normalized.node_index),
        forms: summarizeForms(normalized.node_index),
        player_media_signals: {
          ...media,
          has_video: media.video_count > 0,
          has_player_library: Object.values(media.player_libraries || {}).some(Boolean),
          has_iframe_player_hint: frame_tree.some((frame) => frame.candidate_purpose === 'player'),
        },
        top_links: compactNodes(links, 4),
        top_buttons: compactNodes(buttons, 4),
        deduped_links: summarizeDedupedLinks(normalized.node_index, 12),
        top_candidates: compactNodes(normalized.action_targets, 8),
      },
    });
  });
}

export async function queryElements({
  frame_path = 'root',
  kind = '',
  text_contains = '',
  text_regex = '',
  href_contains = '',
  href_regex = '',
  attr = null,
  attr_name = '',
  attr_value_contains = '',
  attr_value_regex = '',
  visible_only = true,
  limit = 20,
  scope_node_id = '',
  scope_element_ref = '',
  scope_selector = '',
  scope_xpath = '',
  scope_text = '',
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

    let nodes = [];
    let scope_summary = null;
    if (scope_node_id || scope_element_ref || scope_selector || scope_xpath || scope_text) {
      let scopeLocators = {
        element_ref: scope_element_ref,
        selector: scope_selector,
        xpath: scope_xpath,
        text: scope_text,
      };
      if (scope_node_id) {
        const resolvedScope = await resolveScopeNode(page, frame_path, scope_node_id);
        if (!resolvedScope.ok) {
          return buildEnvelope(page, {
            frame_path,
            ok: false,
            error: resolvedScope.error,
          });
        }
        scopeLocators = {
          element_ref: resolvedScope.node.element_ref,
          selector: resolvedScope.node.selector,
          xpath: resolvedScope.node.xpath,
          text: resolvedScope.node.text_preview,
        };
      }

      const scoped = await scopedNodeIndexFromDetail(page, {
        frame_path,
        ...scopeLocators,
      });
      if (!scoped.ok) {
        return buildEnvelope(page, {
          frame_path,
          ok: false,
          error: scoped.error,
        });
      }
      nodes = scoped.node_index;
      scope_summary = {
        frame_path: scoped.frame_path,
        node_count: scoped.node_index.length,
        context_tree: scoped.context_tree,
      };
    } else {
      const { normalized } = await buildNormalizedFrameObservation(frameState.frame, frameState, {
        max_depth: 6,
        max_children_per_node: 45,
      });
      nodes = normalized.node_index;
    }

    const normalizedLimit = normalizeLimit(limit);
    const normalizedAttr = attr
      || (attr_name ? { name: attr_name, value_contains: attr_value_contains, value_regex: attr_value_regex } : null);
    const effectiveAttrName = String(normalizedAttr?.name || attr_name || '');
    const effectiveAttrValueContains = String(normalizedAttr?.value_contains || attr_value_contains || '');
    const effectiveAttrValueRegex = String(normalizedAttr?.value_regex || attr_value_regex || '');
    const fallback_notes = [];
    const textRegex = toSafeRegex(text_regex);
    if (text_regex && !textRegex) fallback_notes.push(`Ignored invalid text_regex pattern: ${text_regex}`);
    const hrefRegex = toSafeRegex(href_regex);
    if (href_regex && !hrefRegex) fallback_notes.push(`Ignored invalid href_regex pattern: ${href_regex}`);
    const attrValueRegex = toSafeRegex(effectiveAttrValueRegex);
    if (effectiveAttrValueRegex && !attrValueRegex) {
      fallback_notes.push(`Ignored invalid attr_value_regex pattern: ${effectiveAttrValueRegex}`);
    }

    const visibleNodes = visible_only ? nodes.filter((node) => node.visible) : nodes;
    const primaryMatches = visibleNodes.filter((node) => {
      if (!kindMatches(node, kind)) return false;
      if (text_contains) {
        const haystack = `${node.text_preview || ''} ${node.name || ''}`.toLowerCase();
        if (!haystack.includes(String(text_contains).toLowerCase())) return false;
      }
      if (textRegex && !textRegex.test(String(node.text_preview || node.name || ''))) return false;
      if (href_contains) {
        const href = String(node.href || node.src || '').toLowerCase();
        if (!href.includes(String(href_contains).toLowerCase())) return false;
      }
      if (hrefRegex && !hrefRegex.test(String(node.href || node.src || ''))) return false;
      if (effectiveAttrName) {
        const attrValue = String(node.attributes?.[effectiveAttrName] || '');
        if (!attrValue) return false;
        if (effectiveAttrValueContains && !attrValue.toLowerCase().includes(effectiveAttrValueContains.toLowerCase())) return false;
        if (attrValueRegex && !attrValueRegex.test(attrValue)) return false;
      }
      return true;
    });

    let strategy = visible_only ? 'strict_visible' : 'strict';
    let matches = primaryMatches;

    if (!matches.length && visible_only) {
      matches = nodes.filter((node) => kindMatches(node, kind));
      if (matches.length) {
        strategy = 'relaxed_visibility';
        fallback_notes.push('No visible matches; included hidden candidates.');
      }
    }

    if (!matches.length && text_contains) {
      const tokens = tokenizeNeedle(text_contains);
      matches = nodes.filter((node) => {
        if (!kindMatches(node, kind)) return false;
        const haystack = `${node.text_preview || ''} ${node.name || ''}`.toLowerCase();
        return tokens.some((token) => haystack.includes(token));
      });
      if (matches.length) {
        strategy = 'token_text_fallback';
        fallback_notes.push('Strict text matching returned no results; token fallback used.');
      }
    }

    const rankedMatches = rankMatches(dedupeByElementRef(matches), {
      kind,
      text_contains,
      text_regex,
      href_contains,
      href_regex,
      attr_name: effectiveAttrName,
      attr_value_contains: effectiveAttrValueContains,
      attr_value_regex: effectiveAttrValueRegex,
    });
    const returnedMatches = rankedMatches.slice(0, normalizedLimit);

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
          visible_only,
          limit: normalizedLimit,
          scope_node_id,
        },
        scope: scope_summary,
        search_strategy: strategy,
        total_matches: rankedMatches.length,
        returned_matches: returnedMatches.length,
        fallback_notes,
        available_counts: {
          total_nodes: nodes.length,
          by_kind: summarizeNodeKinds(nodes),
        },
        matches: compactNodes(returnedMatches, normalizedLimit),
      },
    });
  });
}

export async function getElementDetail({
  frame_path = 'root',
  node_id = '',
  element_ref = '',
  selector = '',
  xpath = '',
  text = '',
  include_html = false,
  html_mode = 'outer',
  max_subtree_depth = 4,
  max_children_per_node = 25,
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    let effectiveLocators = { element_ref, selector, xpath, text };
    if (node_id && !element_ref && !selector && !xpath && !text) {
      const resolvedScope = await resolveScopeNode(page, frame_path, node_id);
      if (!resolvedScope.ok) {
        return buildEnvelope(page, {
          frame_path,
          ok: false,
          error: resolvedScope.error,
        });
      }
      effectiveLocators = {
        element_ref: resolvedScope.node.element_ref,
        selector: resolvedScope.node.selector,
        xpath: resolvedScope.node.xpath,
        text: resolvedScope.node.text_preview,
      };
    }

    const detail = await readElementDetail(page, {
      frame_path,
      ...effectiveLocators,
      include_html,
      html_mode,
      max_subtree_depth,
      max_children_per_node,
    });
    if (!detail.ok) {
      return buildEnvelope(page, {
        frame_path: detail.frame_path || frame_path,
        ok: false,
        error: detail.error,
        data: {
          error_code: detail.code || 'element_detail_failed',
          stale_ref_detected: Boolean(detail.stale_ref_detected),
          frame_fallback_applied: Boolean(detail.frame_fallback_applied),
          resolution_attempts: detail.resolution_attempts || [],
        },
      });
    }

    const normalized = detail.detail?.subtree
      ? buildNormalizedTreeArtifacts(detail.detail.subtree, {
        frame_path: detail.frame_path,
        dom_epoch: detail.dom_epoch,
        page_state_id: detail.page_state_id,
      })
      : { context_tree: null, node_index: [], action_targets: [] };
    const collections = summarizeScopedCollections(normalized.node_index);
    const rootDetail = normalized.context_tree || null;

    return buildEnvelope(page, {
      frame_path: detail.frame_path,
      screenshot: detail.screenshot,
      screenshotMode: 'element',
      data: {
        detail: {
          tag: detail.detail?.tag || rootDetail?.tag || '',
          text: detail.detail?.text || rootDetail?.text_preview || '',
          html_preview: detail.detail?.html_preview || '',
          attrs: detail.detail?.attrs || rootDetail?.attributes || {},
          state: detail.detail?.state || {},
          geometry: detail.detail?.geometry || rootDetail?.bbox || {},
          selector: detail.detail?.selector || rootDetail?.selector || '',
          xpath: detail.detail?.xpath || rootDetail?.xpath || '',
          visible: detail.detail?.visible ?? rootDetail?.visible ?? true,
          nearby_text: detail.detail?.nearby_text || '',
        },
        subtree: compactContextTree(normalized.context_tree, {
          maxDepth: Math.min(Number(max_subtree_depth || 4), 4),
          maxChildrenPerNode: Math.min(Number(max_children_per_node || 25), 12),
          textLimit: 80,
          includeBBox: true,
        }),
        subtree_summary: {
          total_nodes: normalized.node_index.length,
          counts_by_kind: summarizeNodeKinds(normalized.node_index),
        },
        action_targets: compactActionTargets(normalized.action_targets, {
          limit: Math.min(Number(max_children_per_node || 25), 10),
          textLimit: 70,
        }),
        links: compactNodes(collections.links, 8),
        interactives: compactNodes(collections.interactives, 8),
        tables: compactNodes(collections.tables, 4),
        iframes: compactNodes(collections.iframes, 4),
        media: compactNodes(collections.media, 4),
        html: include_html ? detail.detail?.html || '' : '',
        html_mode: include_html ? html_mode : '',
        locator_used: detail.locator_used || {},
        stale_ref_detected: Boolean(detail.stale_ref_detected),
        frame_fallback_applied: Boolean(detail.frame_fallback_applied),
        frame_relocated: Boolean(detail.frame_relocated),
        resolution_attempts: detail.resolution_attempts || [],
      },
    });
  });
}

export async function getMediaState({
  frame_path = 'root',
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frameState = await buildFrameState(page, frame_path);
    if (!frameState.ok) {
      return buildEnvelope(page, { frame_path, ok: false, error: frameState.error });
    }

    const mediaState = await getMediaSummary(frameState.frame);
    const videos = Array.isArray(mediaState.videos) ? mediaState.videos : [];
    const playbackStarted = videos.some((video) =>
      (!video.paused && (Number(video.ready_state || 0) >= 2 || Number(video.current_time || 0) > 0))
      || Number(video.current_time || 0) > 0);
    const playbackReady = videos.some((video) => Number(video.ready_state || 0) >= 2);

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

export async function getFrameTree({
  browserWsEndpoint,
} = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const frame_tree = await buildFrameTree(page);
    return buildEnvelope(page, {
      frame_path: 'root',
      data: {
        frame_tree,
        frame_catalog: buildFrameCatalog(frame_tree),
      },
    });
  });
}
