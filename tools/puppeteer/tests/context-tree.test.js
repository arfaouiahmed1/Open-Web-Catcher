import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFrameCatalog, buildNormalizedTreeArtifacts, findNodeById } from '../tools/context-tree.js';
import { buildInspectResponse } from '../tools/inspect.js';

function sampleTree() {
  return {
    node_id: 'node-1',
    tag: 'main',
    selector: 'main',
    xpath: '//html[1]/body[1]/main[1]',
    text_preview: 'Main content',
    text: 'Main content',
    attributes: { id: 'content' },
    visible: true,
    bbox: { x: 0, y: 0, width: 900, height: 700 },
    children: [
      {
        node_id: 'node-2',
        tag: 'header',
        selector: 'header',
        xpath: '//html[1]/body[1]/main[1]/header[1]',
        text_preview: 'Live matches',
        text: 'Live matches',
        attributes: {},
        visible: true,
        bbox: { x: 0, y: 0, width: 900, height: 120 },
        children: [
          {
            node_id: 'node-3',
            tag: 'a',
            selector: 'header > a:nth-of-type(1)',
            xpath: '//html[1]/body[1]/main[1]/header[1]/a[1]',
            text_preview: 'Watch now',
            text: 'Watch now',
            attributes: { href: 'https://example.com/watch/1' },
            visible: true,
            bbox: { x: 20, y: 20, width: 120, height: 30 },
            children: [],
          },
        ],
      },
      {
        node_id: 'node-4',
        tag: 'table',
        selector: 'table',
        xpath: '//html[1]/body[1]/main[1]/table[1]',
        text_preview: '',
        text: '',
        attributes: {},
        visible: true,
        bbox: { x: 0, y: 140, width: 600, height: 180 },
        children: [
          {
            node_id: 'node-5',
            tag: 'tr',
            selector: 'table > tr:nth-of-type(1)',
            xpath: '//html[1]/body[1]/main[1]/table[1]/tr[1]',
            text_preview: '',
            text: '',
            attributes: {},
            visible: true,
            bbox: { x: 0, y: 140, width: 600, height: 40 },
            children: [
              {
                node_id: 'node-6',
                tag: 'td',
                selector: 'td',
                xpath: '//html[1]/body[1]/main[1]/table[1]/tr[1]/td[1]',
                text_preview: 'Row value',
                text: 'Row value',
                attributes: {},
                visible: true,
                bbox: { x: 0, y: 140, width: 300, height: 40 },
                children: [],
              },
            ],
          },
        ],
      },
      {
        node_id: 'node-7',
        tag: 'iframe',
        selector: 'iframe',
        xpath: '//html[1]/body[1]/main[1]/iframe[1]',
        text_preview: '',
        text: '',
        attributes: { src: 'https://embed.example.com/player' },
        visible: true,
        bbox: { x: 0, y: 340, width: 640, height: 360 },
        children: [],
      },
    ],
  };
}

test('buildNormalizedTreeArtifacts returns tree-first context with actionable handles', () => {
  const normalized = buildNormalizedTreeArtifacts(sampleTree(), {
    frame_path: 'root',
    dom_epoch: 'dom-1',
    page_state_id: 'page-1',
  });

  assert.equal(normalized.context_tree.semantic_kind, 'region');
  assert.ok(Array.isArray(normalized.node_index));
  assert.ok(normalized.node_index.length >= 7);
  assert.ok(normalized.action_targets.some((node) => node.semantic_kind === 'link'));
  assert.ok(normalized.action_targets.some((node) => node.semantic_kind === 'iframe'));

  const tableNode = findNodeById(normalized.node_index, 'node-4');
  assert.equal(tableNode.semantic_kind, 'table');
  assert.equal(tableNode.counts.tables, 1);
  assert.equal(tableNode.counts.links, 0);

  const linkNode = findNodeById(normalized.node_index, 'node-3');
  assert.equal(linkNode.semantic_kind, 'link');
  assert.equal(linkNode.href, 'https://example.com/watch/1');
  assert.ok(linkNode.element_ref);
});

test('buildFrameCatalog returns frame follow-up handles', () => {
  const catalog = buildFrameCatalog([
    {
      frame_path: 'root.0',
      parent_frame_path: 'root',
      depth: 1,
      title: 'Embedded player',
      url: 'https://embed.example.com/player',
      purpose_hint: 'player',
      total_links: 2,
      total_buttons: 3,
      total_iframes: 0,
      video_count: 1,
      has_server_controls: true,
      has_player_library: true,
      error: null,
    },
  ]);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].purpose_hint, 'player');
  assert.equal(catalog[0].follow_up.frame_path, 'root.0');
  assert.equal(catalog[0].follow_up.selector, 'body');
  assert.equal(catalog[0].follow_up.xpath, '//html[1]/body[1]');
});

test('buildInspectResponse preserves compatibility fields while adding normalized contract', () => {
  const observation = {
    metadata: { title: 'Watch page' },
    document_stats: { link_count: 1, original_node_count: 7 },
    outline: { headings: [], landmarks: [] },
    tree: sampleTree(),
    regions: [
      { tag: 'header', selector: 'header', links_count: 1 },
      { tag: 'main', selector: 'main', links_count: 1 },
    ],
    links: [
      {
        href: 'https://example.com/watch/1',
        raw_href: '/watch/1',
        text: 'Watch now',
        selector: 'header > a:nth-of-type(1)',
        xpath: '//html[1]/body[1]/main[1]/header[1]/a[1]',
        node_id: 'node-3',
        visible: true,
        region_selector: 'header',
        ancestor_text_preview: 'Live matches',
        attributes: { href: 'https://example.com/watch/1' },
        bbox: { x: 20, y: 20, width: 120, height: 30 },
      },
    ],
    interactive_elements: [
      {
        node_id: 'node-3',
        selector: 'header > a:nth-of-type(1)',
        xpath: '//html[1]/body[1]/main[1]/header[1]/a[1]',
        tag: 'a',
        text: 'Watch now',
        visible: true,
        disabled: false,
        attributes: { href: 'https://example.com/watch/1', role: '' },
        bbox: { x: 20, y: 20, width: 120, height: 30 },
      },
    ],
    forms: [],
    media: {
      iframes: [
        {
          selector: 'iframe',
          xpath: '//html[1]/body[1]/main[1]/iframe[1]',
          src: 'https://embed.example.com/player',
          visible: true,
          bbox: { x: 0, y: 340, width: 640, height: 360 },
        },
      ],
      videos: [],
      audio: [],
      images: [],
      sources: [],
      tracks: [],
    },
    shadow_roots: [],
    scripts: { external: [], inline_summaries: [], script_url_strings: [], script_object_keys: [] },
    pruning: {},
  };

  const response = buildInspectResponse({
    config: { wait_ms: 1500, scanMode: 'default', response_profile: 'public_compact' },
    requestedUrl: 'https://example.com/watch/1',
    finalUrl: 'https://example.com/watch/1',
    pageContext: {
      title: 'Watch page',
      language: 'en',
      direction: 'ltr',
      viewport: { width: 1280, height: 720 },
      timestamp: '2026-05-14T00:00:00.000Z',
    },
    pageState: {
      frame_path: 'root',
      dom_epoch: 'dom-1',
      page_state_id: 'page-1',
    },
    loadState: {
      domcontentloaded: true,
      load: true,
      network_idle_reached: true,
      waited_ms: 1500,
      console_errors: [],
      page_errors: [],
    },
    observation,
    frames: [],
    network: { resource_summary: {}, requests: [], responses: [] },
    dataResponses: [],
    mutationObservations: [],
    storage: { local_storage_keys: [], session_storage_keys: [], cookies_summary: [] },
    snapshots: { initial_tree: null, after_wait_tree: null, after_scroll_tree: null, after_interaction_tree: null },
    screenshotUrl: 'https://res.cloudinary.com/demo/image/upload/v1/inspect.png',
    pageDigest: { text_sample: 'Watch page content', html_size: 1000, node_count: 7 },
    frameRecords: [
      {
        frame_path: 'root.0',
        parent_frame_path: 'root',
        depth: 1,
        title: 'Embedded player',
        text_sample: 'player',
        text_hash: 1,
        url: 'https://embed.example.com/player',
        total_links: 0,
        total_buttons: 0,
        total_iframes: 0,
        video_count: 1,
        has_server_controls: false,
        has_player_library: true,
        player_libraries_detail: { hls: true },
        purpose_hint: 'player',
        sample_links: [],
        sample_buttons: [],
        links: [],
        buttons: [],
        error: null,
      },
    ],
  });

  assert.ok(response.context_tree);
  assert.ok(Array.isArray(response.node_index));
  assert.ok(Array.isArray(response.action_targets));
  assert.ok(Array.isArray(response.frame_catalog));
  assert.ok(Array.isArray(response.contentLinks));
  assert.ok(response.page_summary);
  assert.equal(response.frame_tree, undefined);
  assert.equal(response.screenshot_url, 'https://res.cloudinary.com/demo/image/upload/v1/inspect.png');
  assert.equal(response.page.final_url, 'https://example.com/watch/1');
  assert.ok(response.node_index.length <= 18);
  assert.ok(response.action_targets.length <= 8);
  assert.ok(response.frame_catalog.length <= 6);
  assert.equal(response.frame_catalog[0].follow_up.frame_root_ref, undefined);
  assert.equal(response.pagination.total_candidates, 2);
  assert.ok(response.pagination.elements.length <= 6);
  assert.ok(JSON.stringify(response).length < 20000);
});

test('buildInspectResponse keeps richer compatibility fields for internal profile consumers', () => {
  const observation = {
    metadata: { title: 'Watch page' },
    document_stats: { link_count: 1, original_node_count: 7 },
    outline: { headings: [], landmarks: [] },
    tree: sampleTree(),
    links: [],
    interactive_elements: [],
    forms: [],
    media: { iframes: [], videos: [], audio: [], images: [], sources: [], tracks: [] },
    shadow_roots: [],
    scripts: { external: [], inline_summaries: [], script_url_strings: [], script_object_keys: [] },
    pruning: {},
  };

  const response = buildInspectResponse({
    config: { wait_ms: 1500, scanMode: 'hosting', response_profile: 'internal_rich', include_network: true },
    requestedUrl: 'https://example.com/watch/1',
    finalUrl: 'https://example.com/watch/1',
    pageContext: {
      title: 'Watch page',
      language: 'en',
      direction: 'ltr',
      viewport: { width: 1280, height: 720 },
      timestamp: '2026-05-14T00:00:00.000Z',
    },
    pageState: {
      frame_path: 'root',
      dom_epoch: 'dom-1',
      page_state_id: 'page-1',
    },
    loadState: {
      domcontentloaded: true,
      load: true,
      network_idle_reached: true,
      waited_ms: 1500,
      console_errors: [],
      page_errors: [],
    },
    observation,
    frames: [],
    network: { resource_summary: {}, requests: [{ url: 'https://cdn.example.com/master.m3u8' }], responses: [] },
    dataResponses: [],
    mutationObservations: [],
    storage: { local_storage_keys: [], session_storage_keys: [], cookies_summary: [] },
    snapshots: { initial_tree: null, after_wait_tree: null, after_scroll_tree: null, after_interaction_tree: null },
    screenshotUrl: 'https://res.cloudinary.com/demo/image/upload/v1/inspect.png',
    pageDigest: { text_sample: 'Watch page content', html_size: 1000, node_count: 7 },
    frameRecords: [],
  });

  assert.ok(Array.isArray(response.frame_tree));
  assert.ok(response.network);
  assert.ok(response.network_summary);
});
