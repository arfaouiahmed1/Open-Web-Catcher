import { encodeElementRef } from '../shared/tool-runtime.js';

const ACTIONABLE_KINDS = new Set([
  'link',
  'button',
  'input',
  'select',
  'checkbox',
  'radio',
  'tab',
  'iframe',
  'media',
]);

function normalizeText(value, max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function pickName(node = {}) {
  const attributes = node.attributes || node.attrs || {};
  return normalizeText(
    node.name
      || attributes['aria-label']
      || attributes.title
      || attributes.name
      || attributes.alt
      || attributes.placeholder
      || attributes.id
      || node.text_preview
      || node.text,
    180,
  );
}

function pickClassNames(attributes = {}) {
  return normalizeText(attributes.class || attributes.className || '', 180);
}

export function inferSemanticKindFromNode(node = {}) {
  const tag = String(node.tag || '').toLowerCase();
  const attributes = node.attributes || node.attrs || {};
  const role = String(node.role || attributes.role || '').toLowerCase();
  const type = String(node.type || attributes.type || '').toLowerCase();
  const classText = `${attributes.class || ''} ${attributes.className || ''}`.toLowerCase();

  if (tag === 'iframe') return 'iframe';
  if (tag === 'table' || role === 'table' || role === 'grid') return 'table';
  if (tag === 'tr' || role === 'row') return 'row';
  if (tag === 'td' || tag === 'th' || role === 'cell' || role === 'gridcell') return 'cell';
  if (/^h[1-6]$/.test(tag) || role === 'heading') return 'heading';
  if (tag === 'a' || role === 'link' || attributes.href) return 'link';
  if (tag === 'button' || role === 'button' || attributes.onclick) return 'button';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    return 'input';
  }
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'input';
  if (tag === 'video' || tag === 'audio' || tag === 'img' || tag === 'picture' || tag === 'source' || tag === 'track') {
    return 'media';
  }
  if (role === 'tab' || /\btab\b/.test(classText)) return 'tab';
  if (tag === 'header' || tag === 'footer' || tag === 'nav' || tag === 'main' || tag === 'aside' || tag === 'section' || tag === 'article' || tag === 'form') {
    return 'region';
  }
  if (/\b(grid|cards?|list|results?)\b/.test(classText) || tag === 'ul' || tag === 'ol') return 'container';
  if (tag === 'li') return 'item';
  if (tag === 'div' || tag === 'figure' || tag === 'figcaption' || tag === 'details' || tag === 'summary' || tag === 'label') {
    return 'container';
  }
  return 'element';
}

function incrementSemanticCount(counts, semanticKind) {
  switch (semanticKind) {
    case 'link':
      counts.links += 1;
      break;
    case 'button':
    case 'tab':
      counts.buttons += 1;
      break;
    case 'input':
    case 'select':
    case 'checkbox':
    case 'radio':
      counts.inputs += 1;
      break;
    case 'table':
      counts.tables += 1;
      break;
    case 'iframe':
      counts.iframes += 1;
      break;
    case 'media':
      counts.media += 1;
      break;
    case 'heading':
      counts.headings += 1;
      break;
    case 'region':
      counts.regions += 1;
      break;
    default:
      break;
  }
}

function createSyntheticElementRef({
  frame_path = 'root',
  selector = '',
  xpath = '',
  text = '',
  tag = 'body',
  kind = 'element',
  dom_epoch = '',
  page_state_id = '',
  node_id = '',
} = {}) {
  return encodeElementRef({
    frame_path,
    selector,
    xpath,
    text,
    tag,
    kind,
    dom_epoch,
    page_state_id,
    node_id,
  });
}

function decorateContextNode(node, context, parent_node_id = '', depth = 0) {
  if (!node || typeof node !== 'object') return { node: null, counts: null, nodeIndex: [] };

  const semantic_kind = inferSemanticKindFromNode(node);
  const role = String(node.role || node.attributes?.role || '').toLowerCase();
  const text_preview = normalizeText(node.text_preview || node.text || '', 220);
  const name = pickName(node);
  const selector = String(node.selector || '').trim();
  const xpath = String(node.xpath || '').trim();
  const bbox = node.bbox || node.geometry || null;
  const attributes = node.attributes || node.attrs || {};
  const element_ref = createSyntheticElementRef({
    frame_path: context.frame_path,
    selector,
    xpath,
    text: text_preview || name,
    tag: node.tag || '',
    kind: semantic_kind,
    dom_epoch: context.dom_epoch,
    page_state_id: context.page_state_id,
    node_id: node.node_id || '',
  });
  const counts = {
    links: 0,
    buttons: 0,
    inputs: 0,
    tables: 0,
    iframes: 0,
    media: 0,
    headings: 0,
    regions: 0,
    descendants: 0,
  };
  incrementSemanticCount(counts, semantic_kind);

  const children = [];
  const nodeIndex = [];
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const result = decorateContextNode(child, context, node.node_id || '', depth + 1);
    if (!result.node) continue;
    children.push(result.node);
    nodeIndex.push(...result.nodeIndex);
    for (const [key, value] of Object.entries(result.counts || {})) {
      counts[key] = toNumber(counts[key]) + toNumber(value);
    }
    counts.descendants += 1;
  }

  const normalizedNode = {
    node_id: node.node_id || '',
    parent_node_id,
    depth,
    frame_path: context.frame_path,
    element_ref,
    tag: String(node.tag || '').toLowerCase(),
    semantic_kind,
    role,
    class_names: pickClassNames(attributes),
    name,
    selector,
    xpath,
    text_preview,
    visible: Boolean(node.visible),
    bbox,
    attributes,
    counts: {
      links: counts.links,
      buttons: counts.buttons,
      inputs: counts.inputs,
      tables: counts.tables,
      iframes: counts.iframes,
      media: counts.media,
      headings: counts.headings,
      regions: counts.regions,
    },
    children,
  };

  nodeIndex.unshift({
    ...normalizedNode,
    children: undefined,
    href: String(attributes.href || attributes.src || '').trim(),
    src: String(attributes.src || '').trim(),
    is_actionable: ACTIONABLE_KINDS.has(semantic_kind),
  });

  return {
    node: normalizedNode,
    counts,
    nodeIndex,
  };
}

export function buildNormalizedTreeArtifacts(tree, {
  frame_path = 'root',
  dom_epoch = '',
  page_state_id = '',
} = {}) {
  const result = decorateContextNode(tree, { frame_path, dom_epoch, page_state_id });
  const context_tree = result.node;
  const node_index = result.nodeIndex;
  const action_targets = node_index
    .filter((node) => node.is_actionable)
    .map((node) => ({
      node_id: node.node_id,
      element_ref: node.element_ref,
      frame_path: node.frame_path,
      semantic_kind: node.semantic_kind,
      tag: node.tag,
      class_names: node.class_names,
      name: node.name,
      text_preview: node.text_preview,
      selector: node.selector,
      xpath: node.xpath,
      bbox: node.bbox,
      href: node.href || '',
      src: node.src || '',
      visible: Boolean(node.visible),
    }));

  return {
    context_tree,
    node_index,
    action_targets,
  };
}

function clampPositiveInteger(value, fallback, max = 200) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function compactText(value, max = 120) {
  return normalizeText(value, max);
}

function compactNodeSummary(
  node = {},
  { includeBBox = false, textLimit = 120, includeElementRef = false } = {},
) {
  const summary = {
    node_id: String(node.node_id || ''),
    parent_node_id: String(node.parent_node_id || ''),
    frame_path: String(node.frame_path || 'root'),
    tag: String(node.tag || '').toLowerCase(),
    semantic_kind: String(node.semantic_kind || node.tag || 'element'),
    role: String(node.role || ''),
    class_names: compactText(node.class_names || '', 120),
    name: compactText(node.name || '', textLimit),
    text_preview: compactText(node.text_preview || '', textLimit),
    selector: String(node.selector || ''),
    xpath: String(node.xpath || ''),
    visible: Boolean(node.visible),
    counts: node.counts || {},
  };

  if (includeElementRef && node.element_ref) summary.element_ref = node.element_ref;
  if (node.href) summary.href = String(node.href || '');
  if (node.src) summary.src = String(node.src || '');
  if (includeBBox && node.bbox) summary.bbox = node.bbox;
  return summary;
}

export function compactContextTree(
  node,
  {
    maxDepth = 4,
    maxChildrenPerNode = 12,
    textLimit = 120,
    includeBBox = false,
  } = {},
) {
  if (!node || typeof node !== 'object') return null;
  const boundedDepth = clampPositiveInteger(maxDepth, 4, 12);
  const boundedChildren = clampPositiveInteger(maxChildrenPerNode, 12, 40);

  const visit = (entry, depth = 0) => {
    if (!entry || typeof entry !== 'object') return null;
    const projected = compactNodeSummary(entry, {
      includeBBox,
      textLimit,
      includeElementRef: false,
    });
    const rawChildren = Array.isArray(entry.children) ? entry.children : [];
    if (depth >= boundedDepth) {
      if (rawChildren.length) projected.child_count = rawChildren.length;
      return projected;
    }
    const children = rawChildren
      .slice(0, boundedChildren)
      .map((child) => visit(child, depth + 1))
      .filter(Boolean);
    if (children.length) projected.children = children;
    if (rawChildren.length > children.length) {
      projected.truncated_children = rawChildren.length - children.length;
    }
    return projected;
  };

  return visit(node, 0);
}

export function compactNodeIndex(
  nodes = [],
  {
    limit = 60,
    textLimit = 100,
    actionableFirst = true,
    includeBBox = false,
  } = {},
) {
  const boundedLimit = clampPositiveInteger(limit, 60, 160);
  const sorted = actionableFirst
    ? [...nodes].sort((left, right) => Number(Boolean(right.is_actionable)) - Number(Boolean(left.is_actionable)))
    : [...nodes];
  return sorted.slice(0, boundedLimit).map((node) => compactNodeSummary(node, {
    includeBBox,
    textLimit,
    includeElementRef: false,
  }));
}

export function compactActionTargets(
  targets = [],
  { limit = 30, textLimit = 90, includeBBox = true } = {},
) {
  const boundedLimit = clampPositiveInteger(limit, 30, 120);
  return targets.slice(0, boundedLimit).map((node) => ({
    node_id: String(node.node_id || ''),
    frame_path: String(node.frame_path || 'root'),
    semantic_kind: String(node.semantic_kind || node.tag || 'element'),
    tag: String(node.tag || '').toLowerCase(),
    class_names: compactText(node.class_names || '', 120),
    name: compactText(node.name || '', textLimit),
    text_preview: compactText(node.text_preview || '', textLimit),
    selector: String(node.selector || ''),
    xpath: String(node.xpath || ''),
    href: String(node.href || ''),
    src: String(node.src || ''),
    visible: Boolean(node.visible),
    ...(includeBBox && node.bbox ? { bbox: node.bbox } : {}),
  }));
}

export function compactFrameCatalog(
  frames = [],
  { limit = 12 } = {},
) {
  const boundedLimit = clampPositiveInteger(limit, 12, 40);
  return frames.slice(0, boundedLimit).map((frame) => ({
    frame_path: String(frame.frame_path || 'root'),
    parent_frame_path: String(frame.parent_frame_path || ''),
    depth: Number(frame.depth || 0),
    title: compactText(frame.title || '', 120),
    url: String(frame.url || ''),
    purpose_hint: String(frame.purpose_hint || 'unknown'),
    accessible: Boolean(frame.accessible),
    has_player_library: Boolean(frame.has_player_library),
    has_server_controls: Boolean(frame.has_server_controls),
    counts: frame.counts || {},
    follow_up: {
      frame_path: String(frame.follow_up?.frame_path || frame.frame_path || 'root'),
      selector: String(frame.follow_up?.selector || 'body'),
      xpath: String(frame.follow_up?.xpath || '//html[1]/body[1]'),
    },
  }));
}

export function summarizeNodeKinds(nodes = []) {
  const counts = {};
  for (const node of nodes) {
    const key = String(node.semantic_kind || node.tag || 'element');
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function buildFrameCatalog(frameRecords = []) {
  return frameRecords.map((frame) => ({
    frame_path: frame.frame_path,
    parent_frame_path: frame.parent_frame_path,
    depth: Number(frame.depth || 0),
    title: frame.title || '',
    url: frame.url || '',
    purpose_hint: frame.purpose_hint || frame.candidate_purpose || 'unknown',
    accessible: frame.accessible ?? !frame.error,
    has_player_library: Boolean(frame.has_player_library),
    has_server_controls: Boolean(frame.has_server_controls),
    counts: {
      links: Number(frame.total_links ?? frame.signals?.links ?? 0),
      buttons: Number(frame.total_buttons ?? frame.signals?.buttons ?? 0),
      iframes: Number(frame.total_iframes ?? frame.signals?.iframes ?? 0),
      videos: Number(frame.video_count ?? frame.signals?.videos ?? 0),
    },
    follow_up: {
      frame_path: frame.frame_path,
      selector: 'body',
      xpath: '//html[1]/body[1]',
    },
  }));
}

export function summarizeScopedCollections(node_index = []) {
  const summary = {
    links: [],
    interactives: [],
    tables: [],
    iframes: [],
    media: [],
  };

  for (const node of node_index) {
    const item = {
      node_id: node.node_id,
      element_ref: node.element_ref,
      frame_path: node.frame_path,
      semantic_kind: node.semantic_kind,
      tag: node.tag,
      name: node.name,
      text_preview: node.text_preview,
      selector: node.selector,
      xpath: node.xpath,
      bbox: node.bbox,
      href: node.href || '',
      src: node.src || '',
      visible: Boolean(node.visible),
      counts: node.counts || {},
    };

    if (node.semantic_kind === 'link') summary.links.push(item);
    if (ACTIONABLE_KINDS.has(node.semantic_kind)) summary.interactives.push(item);
    if (node.semantic_kind === 'table') summary.tables.push(item);
    if (node.semantic_kind === 'iframe') summary.iframes.push(item);
    if (node.semantic_kind === 'media') summary.media.push(item);
  }

  return summary;
}

export function findNodeById(node_index = [], node_id = '') {
  return node_index.find((entry) => String(entry.node_id || '') === String(node_id || '')) || null;
}
