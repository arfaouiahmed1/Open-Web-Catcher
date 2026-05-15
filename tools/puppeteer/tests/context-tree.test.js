import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFrameCatalog, buildNormalizedTreeArtifacts, findNodeById } from '../tools/context-tree.js';

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
