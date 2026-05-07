/**
 * tool-registry.js - Central MCP tool definitions.
 */

import { z } from 'zod';

import {
  getPageContext as getPageContextTool,
  queryElements as queryElementsTool,
  getElementDetail as getElementDetailTool,
  getMediaState as getMediaStateTool,
  getFrameTree as getFrameTreeTool,
} from './tools/context-tools.js';
import {
  openUrl as openUrlTool,
  goBack as goBackTool,
  scrollPage as scrollPageTool,
  scrollToElement as scrollToElementTool,
  waitForPageState as waitForPageStateTool,
} from './tools/navigation-tools.js';
import {
  clickElement as clickElementTool,
  clickCss as clickCssTool,
  clickText as clickTextTool,
  clickXpath as clickXpathTool,
  clickCheckbox as clickCheckboxTool,
  clickRadio as clickRadioTool,
  typeInto as typeIntoTool,
  selectOption as selectOptionTool,
  playMedia as playMediaTool,
  swipeRegion as swipeRegionTool,
  clickCoordinates as clickCoordinatesTool,
} from './tools/action-tools.js';
import { captureStreams as captureStreamsTool } from './tools/extraction-tools.js';
import { navigate as navigateTool } from './tools/navigate.js';
import { inspect as inspectTool } from './tools/inspect.js';
import { inspectLanding as inspectLandingTool } from './tools/inspect_landing.js';
import { inspectHosting as inspectHostingTool } from './tools/inspect_hosting.js';
import { inspectEmbedded as inspectEmbeddedTool } from './tools/inspect_embedded.js';
import { interact as interactTool } from './tools/interact.js';
import { screenshot as screenshotTool } from './tools/screenshot.js';
import { harvest as harvestTool } from './tools/harvest.js';
import { memoryLookup as memoryLookupTool, memoryUpdate as memoryUpdateTool } from './tools/memory-tools.js';

const DEFAULT_TOOL_IMPLS = {
  get_page_context: getPageContextTool,
  query_elements: queryElementsTool,
  get_element_detail: getElementDetailTool,
  get_media_state: getMediaStateTool,
  get_frame_tree: getFrameTreeTool,
  open_url: openUrlTool,
  go_back: goBackTool,
  scroll_page: scrollPageTool,
  scroll_to_element: scrollToElementTool,
  wait_for_page_state: waitForPageStateTool,
  click_element: clickElementTool,
  click_css: clickCssTool,
  click_text: clickTextTool,
  click_xpath: clickXpathTool,
  click_checkbox: clickCheckboxTool,
  click_radio: clickRadioTool,
  type_into: typeIntoTool,
  select_option: selectOptionTool,
  play_media: playMediaTool,
  swipe_region: swipeRegionTool,
  click_coordinates: clickCoordinatesTool,
  capture_streams: captureStreamsTool,
  navigate: navigateTool,
  inspect: inspectTool,
  inspect_landing: inspectLandingTool,
  inspect_hosting: inspectHostingTool,
  inspect_embedded: inspectEmbeddedTool,
  interact: interactTool,
  screenshot: screenshotTool,
  harvest: harvestTool,
  memory_lookup: memoryLookupTool,
  memory_update: memoryUpdateTool,
};

function formatJsonBlock(label, value) {
  return `${label}:\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function toolUsageGuidance(toolName) {
  const broadInspectors = new Set(['inspect', 'inspect_landing', 'inspect_hosting', 'inspect_embedded', 'get_page_context']);
  const targetedInspectors = new Set(['query_elements', 'get_element_detail', 'get_frame_tree', 'get_media_state', 'capture_streams']);
  const actionTools = new Set([
    'click_element', 'click_css', 'click_text', 'click_xpath', 'click_checkbox', 'click_radio',
    'type_into', 'select_option', 'play_media', 'swipe_region', 'click_coordinates', 'interact',
  ]);

  if (broadInspectors.has(toolName)) {
    return 'Efficiency guidance: Use once after navigation or a meaningful page-state change. Reuse returned frame_path, element_ref, media, and link evidence; do not repeat broad inspection when URL and DOM state are unchanged.';
  }
  if (targetedInspectors.has(toolName)) {
    return 'Efficiency guidance: Use after get_page_context or a profile inspect result when you need narrower evidence. Prefer this over another broad inspect; return values are intended to feed the next action or media verification step.';
  }
  if (actionTools.has(toolName)) {
    return 'Efficiency guidance: Use only after a prior inspect/query/detail result identifies a target. Prefer element_ref when available, then verify observed_change, playback_started, or network diagnostics before calling more tools.';
  }
  if (toolName === 'open_url' || toolName === 'navigate' || toolName === 'go_back') {
    return 'Efficiency guidance: Use only for intentional navigation. After it returns, inspect once, then plan from that snapshot instead of navigating back and re-inspecting unchanged state.';
  }
  return 'Efficiency guidance: Use when its cached or memory output can prevent repeated browser exploration. Do not call it if the current page evidence already answers the question.';
}

function buildDescription(toolName, summary, inputExample, outputExample) {
  return [
    summary,
    toolUsageGuidance(toolName),
    formatJsonBlock('Input JSON', inputExample),
    formatJsonBlock('Output JSON', outputExample),
  ].join('\n\n');
}

const framePathSchema = z.string().optional().default('root').describe('Frame path like root, root.0, root.0.2');
const elementRefSchema = z.string().optional().default('').describe('Element reference returned by query_elements');
const selectorSchema = z.string().optional().default('').describe('CSS selector');
const xpathSchema = z.string().optional().default('').describe('XPath locator');
const textSchema = z.string().optional().default('').describe('Visible text fragment');
const waitMsSchema = z.number().optional().default(1500).describe('Wait after action in milliseconds');
const interactModeSchema = z.enum(['click', 'play', 'type', 'select', 'coordinates', 'check', 'checkbox', 'radio']).optional().default('click');
const locatorStrategySchema = z.enum(['strict', 'xpath_first', 'selector_first', 'text_first']).optional().default('strict');

function spec(summary, inputExample, outputExample, zodSchema, handlerFactory) {
  return {
    summary,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    inputExample,
    outputExample,
    zodSchema,
    handlerFactory,
  };
}

const TOOL_SPECS = {
  get_page_context: spec(
    'Use when you need a fast, broad page scan before taking actions. Returns compact context: frame tree, media/player signals, forms, overlays, pagination hints, top candidates, and screenshot.',
    { frame_path: 'root' },
    { ok: true, frame_path: 'root', screenshot_url: 'https://res.cloudinary.com/...', page_summary: { links: 8 } },
    { frame_path: framePathSchema },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.get_page_context({ ...args, browserWsEndpoint }),
  ),
  query_elements: spec(
    'Use when you already know what to target (kind/text/attrs) and need element_ref handles for follow-up actions. Supports regex matching for noisy pages.',
    {
      frame_path: 'root',
      kind: 'link',
      text_contains: 'watch',
      text_regex: '(watch|play|live)',
      attr_name: 'data-server',
      attr_value_regex: 'server\\s*[0-9]+',
      visible_only: true,
      limit: 10,
    },
    { ok: true, total_matches: 3, matches: [{ kind: 'link', text: 'Watch now', element_ref: '...' }], screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      kind: z.enum(['link', 'button', 'input', 'checkbox', 'radio', 'select', 'video', 'iframe', 'form', 'tab', 'overlay']).optional(),
      text_contains: z.string().optional().default(''),
      text_regex: z.string().optional().default(''),
      href_contains: z.string().optional().default(''),
      href_regex: z.string().optional().default(''),
      attr_name: z.string().optional().default(''),
      attr_value_contains: z.string().optional().default(''),
      attr_value_regex: z.string().optional().default(''),
      visible_only: z.boolean().optional().default(true),
      limit: z.number().optional().default(20),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.query_elements({ ...args, browserWsEndpoint }),
  ),
  get_element_detail: spec(
    'Use when you need to verify one candidate element before clicking/typing. Returns rich detail including geometry, attrs, nearby context, and screenshot.',
    { frame_path: 'root', element_ref: '...' },
    { ok: true, detail: { tag: 'a', text: 'Watch now' }, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      element_ref: elementRefSchema,
      selector: selectorSchema,
      xpath: xpathSchema,
      text: textSchema,
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.get_element_detail({ ...args, browserWsEndpoint }),
  ),
  get_media_state: spec(
    'Use when debugging playback readiness or player libraries in one frame. Returns video/player state without full page context.',
    { frame_path: 'root.0' },
    { ok: true, media_state: { video_count: 1 }, screenshot_url: 'https://res.cloudinary.com/...' },
    { frame_path: framePathSchema },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.get_media_state({ ...args, browserWsEndpoint }),
  ),
  get_frame_tree: spec(
    'Use when iframe routing is unclear and you need deterministic frame_path values. Returns full frame tree with purpose hints.',
    {},
    { ok: true, frame_tree: [{ frame_path: 'root.0', candidate_purpose: 'player' }], screenshot_url: 'https://res.cloudinary.com/...' },
    {},
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.get_frame_tree({ ...args, browserWsEndpoint }),
  ),
  open_url: spec(
    'Use for first navigation to a destination URL. Includes challenge-page detection and optional retry/wait handling (Cloudflare/captcha-like pages) plus redirect/HTTP details and screenshot.',
    {
      url: 'https://example.com/watch',
      wait_until: 'networkidle2',
      timeout_ms: 30000,
      challenge_wait_ms: 6000,
      retry_on_challenge: true,
      max_challenge_retries: 1,
    },
    { ok: true, final_url: 'https://example.com/watch', screenshot_url: 'https://res.cloudinary.com/...' },
    {
      url: z.string().describe('Full URL to open'),
      wait_until: z.enum(['networkidle0', 'networkidle2', 'domcontentloaded', 'load']).optional().default('networkidle2'),
      timeout_ms: z.number().optional().default(30000),
      challenge_wait_ms: z.number().optional().default(6000)
        .describe('How long to wait for challenge pages (Cloudflare/captcha-like) to clear before retrying'),
      retry_on_challenge: z.boolean().optional().default(true)
        .describe('If true, waits for challenge clearance and retries navigation when challenge markers are detected'),
      max_challenge_retries: z.number().optional().default(1)
        .describe('Maximum retry count when challenge markers persist'),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.open_url({ ...args, browserWsEndpoint }),
  ),
  go_back: spec(
    'Use when a prior click/navigation overshot and you need browser-history back navigation with resulting state and screenshot.',
    { timeout_ms: 30000 },
    { ok: true, final_url: 'https://example.com/list', screenshot_url: 'https://res.cloudinary.com/...' },
    { timeout_ms: z.number().optional().default(30000) },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.go_back({ ...args, browserWsEndpoint }),
  ),
  scroll_page: spec(
    'Use when revealing lazy-loaded content in a frame. Scrolls by amount/direction and returns updated state with screenshot.',
    { frame_path: 'root', direction: 'down', amount: 800, behavior: 'auto' },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      direction: z.enum(['up', 'down']).optional().default('down'),
      amount: z.number().optional().default(600),
      behavior: z.enum(['auto', 'smooth']).optional().default('auto'),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.scroll_page({ ...args, browserWsEndpoint }),
  ),
  scroll_to_element: spec(
    'Use when target exists but is off-screen. Scrolls the chosen element into view using element_ref or locator fields.',
    { frame_path: 'root', element_ref: '...' },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      element_ref: elementRefSchema,
      selector: selectorSchema,
      xpath: xpathSchema,
      text: textSchema,
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.scroll_to_element({ ...args, browserWsEndpoint }),
  ),
  wait_for_page_state: spec(
    'Use to synchronize timing before the next step. Waits for network idle, selector/text presence, video readiness, or challenge-page clearing.',
    { frame_path: 'root', mode: 'network_idle', timeout_ms: 10000 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      mode: z.enum(['network_idle', 'navigation_complete', 'selector', 'text', 'video_ready', 'challenge_cleared']).optional().default('network_idle'),
      selector: selectorSchema,
      text: textSchema,
      timeout_ms: z.number().optional().default(10000),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.wait_for_page_state({ ...args, browserWsEndpoint }),
  ),
  click_element: spec(
    'Use for safest click flow after query_elements/get_page_context, because element_ref includes frame and DOM snapshot context.',
    { frame_path: 'root', element_ref: '...', wait_ms: 1500 },
    { ok: true, observed_change: { navigated: false }, screenshot_url: 'https://res.cloudinary.com/...' },
    { frame_path: framePathSchema, element_ref: elementRefSchema, wait_ms: waitMsSchema },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.click_element({ ...args, browserWsEndpoint }),
  ),
  click_css: spec(
    'Use when you have a stable CSS selector and do not need element_ref-based stale-check behavior.',
    { frame_path: 'root', selector: '.server-button', wait_ms: 1500 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    { frame_path: framePathSchema, selector: z.string(), wait_ms: waitMsSchema },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.click_css({ ...args, browserWsEndpoint }),
  ),
  click_text: spec(
    'Use when button/link text is stable but selectors are noisy. Clicks the first visible-text match.',
    { frame_path: 'root', text: 'Watch now', wait_ms: 1500 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    { frame_path: framePathSchema, text: z.string(), wait_ms: waitMsSchema },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.click_text({ ...args, browserWsEndpoint }),
  ),
  click_xpath: spec(
    'Use only when XPath is the most reliable locator (dynamic classes/selectors). Clicks the first XPath match.',
    { frame_path: 'root', xpath: '//button[1]', wait_ms: 1500 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    { frame_path: framePathSchema, xpath: z.string(), wait_ms: waitMsSchema },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.click_xpath({ ...args, browserWsEndpoint }),
  ),
  click_checkbox: spec(
    'Use for idempotent checkbox state changes. Ensures checked=true/false instead of blindly toggling.',
    { frame_path: 'root', selector: 'input[type=checkbox]', checked: true, wait_ms: 1000 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      element_ref: elementRefSchema,
      selector: selectorSchema,
      xpath: xpathSchema,
      text: textSchema,
      checked: z.boolean().optional().default(true),
      wait_ms: waitMsSchema,
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.click_checkbox({ ...args, browserWsEndpoint }),
  ),
  click_radio: spec(
    'Use to set a radio choice by element_ref or locator.',
    { frame_path: 'root', selector: 'input[type=radio]', wait_ms: 1000 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      element_ref: elementRefSchema,
      selector: selectorSchema,
      xpath: xpathSchema,
      text: textSchema,
      wait_ms: waitMsSchema,
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.click_radio({ ...args, browserWsEndpoint }),
  ),
  type_into: spec(
    'Use to fill text inputs or textareas. Clears existing value, types with small delay, then returns updated state.',
    { frame_path: 'root', selector: 'input[name=q]', value: 'team name', wait_ms: 500 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      element_ref: elementRefSchema,
      selector: selectorSchema,
      xpath: xpathSchema,
      text: textSchema,
      value: z.string(),
      wait_ms: z.number().optional().default(500),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.type_into({ ...args, browserWsEndpoint }),
  ),
  select_option: spec(
    'Use for <select> dropdowns when option value/text is known. Supports selection by value or fuzzy text.',
    { frame_path: 'root', selector: 'select', option_text: 'Server 2', wait_ms: 1000 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      element_ref: elementRefSchema,
      selector: selectorSchema,
      xpath: xpathSchema,
      text: textSchema,
      option_text: z.string().optional().default(''),
      option_value: z.string().optional().default(''),
      wait_ms: waitMsSchema,
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.select_option({ ...args, browserWsEndpoint }),
  ),
  play_media: spec(
    'Use when media is visible but not playing. Attempts click-then-play fallback on controls/video elements.',
    { frame_path: 'root.0', selector: 'video', wait_ms: 1500 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      element_ref: elementRefSchema,
      selector: selectorSchema,
      xpath: xpathSchema,
      text: textSchema,
      wait_ms: waitMsSchema,
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.play_media({ ...args, browserWsEndpoint }),
  ),
  swipe_region: spec(
    'Use for drag/swipe gestures (carousels, timelines, sliders) with explicit coordinates and deltas.',
    { frame_path: 'root', x: 960, y: 540, delta_x: -400, delta_y: 0, steps: 12, wait_ms: 500 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      x: z.number(),
      y: z.number(),
      delta_x: z.number().optional().default(0),
      delta_y: z.number().optional().default(0),
      steps: z.number().optional().default(10),
      wait_ms: z.number().optional().default(500),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.swipe_region({ ...args, browserWsEndpoint }),
  ),
  click_coordinates: spec(
    'Use as a fallback when element locators fail (player overlays, canvas, cross-origin iframe hit-targets). Clicks raw viewport coordinates.',
    { frame_path: 'root', x: 960, y: 540, wait_ms: 1500 },
    { ok: true, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      x: z.number(),
      y: z.number(),
      wait_ms: waitMsSchema,
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.click_coordinates({ ...args, browserWsEndpoint }),
  ),
  capture_streams: spec(
    'Use after playback starts to discover stream URLs. Captures HLS/DASH/MP4 evidence from CDP, DOM, player objects, iframe src, and performance entries.',
    { frame_path: 'root.0', duration_ms: 30000, player_iframe_hint: 'embed.example.com' },
    { ok: true, total_streams: 1, streams: [{ url: 'https://cdn.example.com/master.m3u8', protocol: 'hls' }], screenshot_url: 'https://res.cloudinary.com/...' },
    {
      frame_path: framePathSchema,
      duration_ms: z.number().optional().default(30000),
      player_iframe_hint: z.string().optional().default(''),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.capture_streams({ ...args, browserWsEndpoint }),
  ),
  navigate: spec(
    'Navigate to a URL and report final URL, redirects, status, and a screenshot. Use for direct page navigation in the current browser session.',
    { url: 'https://example.com/watch', wait_until: 'networkidle2', timeout_ms: 30000 },
    { success: true, finalUrl: 'https://example.com/watch', httpStatus: 200, screenshot_url: 'https://res.cloudinary.com/...' },
    {
      url: z.string().describe('Full URL to navigate to'),
      wait_until: z.enum(['networkidle', 'networkidle0', 'networkidle2', 'domcontentloaded', 'load']).optional().default('networkidle2'),
      timeout_ms: z.number().optional().default(30000),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.navigate({ ...args, browserWsEndpoint }),
  ),
  inspect: spec(
    'Run a rich DOM + player inspection on the current page and return actionable signals, elements, iframes, and screenshot evidence.',
    {},
    { url: 'https://example.com/watch', title: 'Watch', stats: { buttons: 5 }, screenshot_url: 'https://res.cloudinary.com/...' },
    {},
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.inspect({ ...args, browserWsEndpoint }),
  ),
  inspect_landing: spec(
    'Landing-page context optimized for match URL extraction. Includes lean match candidates with metadata hints, iframe overview, and coordinate-rich locator fields.',
    {},
    { context_type: 'landing', match_candidates: [{ url: 'https://example.com/match/123', selector: '.match-card a', xpath: '//main//a[1]', x: 640, y: 360 }], screenshot_url: 'https://res.cloudinary.com/...' },
    {},
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.inspect_landing({ ...args, browserWsEndpoint }),
  ),
  inspect_hosting: spec(
    'Hosting-page context optimized for stream extraction. Includes deep iframe context, server controls, and playback targets with locators and coordinates.',
    {},
    { context_type: 'hosting', server_controls: [{ text: 'Server 1', selector: '.server-btn', xpath: '//button[1]', x: 580, y: 710 }], screenshot_url: 'https://res.cloudinary.com/...' },
    {},
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.inspect_hosting({ ...args, browserWsEndpoint }),
  ),
  inspect_embedded: spec(
    'Embedded-page context optimized for nested iframe players. Returns frame focus order, source controls, and player targets with minimal payload bloat.',
    {},
    { context_type: 'embedded', frame_focus_order: [{ frame_path: 'root.0', score: 21, video_count: 1 }], screenshot_url: 'https://res.cloudinary.com/...' },
    {},
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.inspect_embedded({ ...args, browserWsEndpoint }),
  ),
  interact: spec(
    'Perform reliable interactions with strict locator strategy support, frame targeting, and explicit verification signals for fallback decisions.',
    {
      mode: 'click',
      element_ref: 'optional-ref-from-query-elements',
      xpath: '//button[contains(.,"Play")]',
      locator_strategy: 'xpath_first',
      fallback_to_coordinates: true,
      wait_ms: 3000,
    },
    {
      success: true,
      verified: true,
      mode: 'click',
      locator: { used: { kind: 'element_ref' }, fallback_used: '' },
      screenshot_url: 'https://res.cloudinary.com/...',
    },
    {
      mode: interactModeSchema,
      element_ref: elementRefSchema,
      selector: z.string().optional().default(''),
      xpath: z.string().optional().default(''),
      text: z.string().optional().default(''),
      value: z.string().optional().default(''),
      option_text: z.string().optional().default(''),
      option_value: z.string().optional().default(''),
      checked: z.boolean().optional(),
      frame_path: z.string().optional().default('root'),
      frame_url_contains: z.string().optional().default(''),
      locator_strategy: locatorStrategySchema,
      x: z.number().optional(),
      y: z.number().optional(),
      fallback_to_coordinates: z.boolean().optional().default(true),
      wait_ms: z.number().optional().default(3000),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.interact({ ...args, browserWsEndpoint }),
  ),
  screenshot: spec(
    'Take a quick viewport/full/element screenshot and report lightweight video playback state.',
    { mode: 'viewport', selector: 'video' },
    { screenshot_url: 'https://res.cloudinary.com/...', video_state: 'playing', url: 'https://example.com/watch' },
    {
      mode: z.enum(['viewport', 'full', 'element']).optional().default('viewport'),
      selector: z.string().optional().default('video'),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.screenshot({ ...args, browserWsEndpoint }),
  ),
  harvest: spec(
    'Capture streaming URLs (m3u8/mpd/mp4/webm) using six detection layers and return protocol-split URL lists plus video state.',
    { duration_ms: 12000, player_iframe_url: 'https://embed.example.com/player/abc' },
    { total: 1, m3u8_urls: ['https://cdn.example.com/master.m3u8'], video_state: 'playing', screenshot_url: 'https://res.cloudinary.com/...' },
    {
      duration_ms: z.number().optional().default(12000),
      player_iframe_url: z.string().optional().default(''),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.harvest({ ...args, browserWsEndpoint }),
  ),
  memory_lookup: spec(
    'Read long-memory profile hints for the current domain/page_type before expensive exploration. Returns remembered selectors, pagination/url patterns, critical links, and related profiles.',
    { url: 'https://example.com/watch/123', page_type: 'hosting_page', include_related: true, limit: 3 },
    {
      ok: true,
      domain: 'example.com',
      page_type: 'hosting_page',
      profile_found: true,
      profile: { selectors: ['selector=.server-btn'] },
      related_profiles: [],
      memory_first_recommendation: 'Use remembered selectors/url patterns first.',
    },
    {
      url: z.string().describe('Target URL or domain for memory lookup'),
      page_type: z.string().optional().default(''),
      include_related: z.boolean().optional().default(true),
      limit: z.number().optional().default(3),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.memory_lookup({ ...args, browserWsEndpoint }),
  ),
  memory_update: spec(
    'Update long-memory profile hints when you discover better selectors, pagination patterns, navigation playbooks, or UI structure changes.',
    {
      url: 'https://example.com/watch/123',
      page_type: 'hosting_page',
      selectors: ['selector=.server-btn', 'xpath=//button[contains(.,"Server 2")]'],
      pagination_url_patterns: ['https://example.com/live?page={n}'],
      url_patterns: ['https://example.com/watch/{n}'],
      navigation_hints: ['url=https://example.com/watch/123'],
      critical_links: ['https://example.com/watch/123', 'https://cdn.example.com/master.m3u8'],
      hosting_candidate_urls: ['https://example.com/watch/123', 'https://example.com/watch/124'],
      server_records: ['{"label":"Server 2","status":"success","stream_count":2}'],
      server_screenshots: ['https://res.cloudinary.com/.../server2.png'],
      server_stream_urls: ['https://cdn.example.com/master.m3u8'],
      activated_servers: ['Server 2'],
      refresh_reason: 'Detected new server switch UI and updated selector strategy',
      replace: false,
    },
    {
      ok: true,
      updated: true,
      domain: 'example.com',
      page_type: 'hosting_page',
      profile: { revision: 4, selectors: ['selector=.server-btn'] },
    },
    {
      url: z.string().describe('Target URL or domain for memory update'),
      page_type: z.string().describe('Agent page type (classification|landing_page|hosting_page|embedded_page)'),
      selectors: z.array(z.string()).optional().default([]),
      pagination_url_patterns: z.array(z.string()).optional().default([]),
      url_patterns: z.array(z.string()).optional().default([]),
      navigation_hints: z.array(z.string()).optional().default([]),
      critical_links: z.array(z.string()).optional().default([]),
      server_labels: z.array(z.string()).optional().default([]),
      stream_hosts: z.array(z.string()).optional().default([]),
      ui_signals: z.array(z.string()).optional().default([]),
      hosting_candidate_urls: z.array(z.string()).optional().default([]),
      server_records: z.array(z.string()).optional().default([]),
      server_screenshots: z.array(z.string()).optional().default([]),
      server_stream_urls: z.array(z.string()).optional().default([]),
      activated_servers: z.array(z.string()).optional().default([]),
      ui_change_notes: z.array(z.string()).optional().default([]),
      ui_change_detected: z.boolean().optional().default(false),
      refresh_reason: z.string().optional().default(''),
      replace: z.boolean().optional().default(false),
    },
    (browserWsEndpoint, toolImpls) => (args) => toolImpls.memory_update({ ...args, browserWsEndpoint }),
  ),
};

for (const [name, specValue] of Object.entries(TOOL_SPECS)) {
  specValue.inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  for (const [key, schema] of Object.entries(specValue.zodSchema)) {
    const property = {};
    if (schema.description) {
      property.description = schema.description;
    }
    specValue.inputSchema.properties[key] = property;
  }
}

function toPublicToolSpec(name, specValue) {
  return {
    name,
    summary: specValue.summary,
    usage_guidance: toolUsageGuidance(name),
    description: buildDescription(name, specValue.summary, specValue.inputExample, specValue.outputExample),
    input_schema: specValue.inputSchema,
    input_example: specValue.inputExample,
    output_example: specValue.outputExample,
  };
}

export function getToolCatalog() {
  return Object.fromEntries(
    Object.entries(TOOL_SPECS).map(([name, specValue]) => [name, toPublicToolSpec(name, specValue)]),
  );
}

export function getToolSpec(toolName) {
  const specValue = TOOL_SPECS[toolName];
  return specValue ? toPublicToolSpec(toolName, specValue) : null;
}

export function getToolDefinitions(browserWsEndpoint, toolImpls = DEFAULT_TOOL_IMPLS, browserProfile = '') {
  return Object.fromEntries(
    Object.entries(TOOL_SPECS).map(([name, specValue]) => [
      name,
      {
        ...toPublicToolSpec(name, specValue),
        schema: specValue.zodSchema,
        handler: (args) => specValue.handlerFactory(browserWsEndpoint, toolImpls)({ ...args, browserProfile }),
      },
    ]),
  );
}
