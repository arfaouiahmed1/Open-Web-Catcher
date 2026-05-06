/**
 * tools/inspect.js — Full DOM scan + player signal detection + screenshot.
 *
 * Returns structured, bounded context used by profile-specific inspect tools.
 */

import { withBrowserSession } from '../shared/tool-runtime.js';
import { screenshotViewport } from '../shared/screenshot.js';

const LIMITS = {
  contentLinks: 80,
  navLinks: 40,
  buttons: 60,
  iframes: 30,
  popups: 10,
  paginationElements: 20,
  videos: 12,
  elements: 140,
  frameTree: 40,
  frameSampleLinks: 8,
  frameSampleButtons: 8,
};

const clean = (value, max = 160) =>
  String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

async function warmLandingLazyContent(page) {
  return page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const visible = (el) => {
      if (!(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0';
    };
    const scrollStep = Math.max(Math.floor(window.innerHeight * 0.8), 320);
    const clickLabels = [];
    const clickSelectors = [
      'button',
      'a[href]',
      '[role="button"]',
      '[data-action]',
      '[data-testid]',
      '[class*="more"]',
      '[class*="load"]',
      '[class*="show"]',
    ].join(',');
    const clickPattern = /(load more|show more|view more|see more|more matches|more events|more streams|expand|show all|view all)/i;
    let scrollSteps = 0;
    let clicked = 0;
    const initialHeight = Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
    );

    for (let pass = 0; pass < 4; pass += 1) {
      const clickCandidates = Array.from(document.querySelectorAll(clickSelectors))
        .filter(visible)
        .filter((node) => clickPattern.test((node.innerText || node.textContent || node.getAttribute('aria-label') || '').trim()))
        .slice(0, 8);
      for (const node of clickCandidates) {
        try {
          node.scrollIntoView({ block: 'center', inline: 'nearest' });
          await sleep(120);
          node.click();
          clicked += 1;
          clickLabels.push((node.innerText || node.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80));
          await sleep(220);
        } catch {
          // ignore
        }
      }

      const sections = Array.from(document.querySelectorAll('main section, main article, [class*="match"], [class*="event"], [class*="card"], [data-testid*="card"], [data-testid*="match"]'))
        .filter(visible)
        .slice(0, 18);
      for (const section of sections) {
        try {
          section.scrollIntoView({ block: 'center', inline: 'nearest' });
          await sleep(90);
        } catch {
          // ignore
        }
      }

      const maxScrollable = Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
      );
      while ((window.scrollY + window.innerHeight) < (maxScrollable - 24)) {
        window.scrollBy({ top: scrollStep, left: 0, behavior: 'instant' });
        scrollSteps += 1;
        await sleep(160);
        if (scrollSteps >= 18) break;
      }
      await sleep(260);
    }

    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await sleep(120);

    return {
      clicked,
      click_labels: clickLabels.slice(0, 8),
      scroll_steps: scrollSteps,
      initial_height: initialHeight,
      final_height: Math.max(
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0,
      ),
    };
  }).catch(() => ({
    clicked: 0,
    click_labels: [],
    scroll_steps: 0,
    initial_height: 0,
    final_height: 0,
  }));
}

function textHash(value) {
  const text = clean(value, 800);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function dedupeBy(items, keyFn, limit = 100) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function frameDepth(framePath) {
  if (!framePath || framePath === 'root') return 0;
  return framePath.split('.').length - 1;
}

function buildFramePathMap(page) {
  const map = new Map();
  const root = page.mainFrame();
  map.set(root, 'root');

  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    const currentPath = map.get(current) || 'root';
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

function applyOffset(entry, offset, framePath) {
  return {
    ...entry,
    x: Math.round((entry.x || 0) + offset.x),
    y: Math.round((entry.y || 0) + offset.y),
    frame_path: framePath,
  };
}

function inferFramePurpose(summary, url) {
  const haystack = `${summary.title || ''} ${summary.text_sample || ''} ${url || ''}`.toLowerCase();

  if (summary.video_count > 0 || summary.has_player_library) return 'player';
  if (summary.has_server_controls) return 'server-controls';
  if (/embed|player|iframe|stream/.test(haystack)) return 'player';
  if (/match|fixture|schedule|channels|league/.test(haystack)) return 'listing';
  if (/ad|banner|doubleclick|analytics|track/.test(haystack)) return 'ad';
  return 'unknown';
}

async function collectRootData(page) {
  return page.evaluate((limits) => {
    const cleanText = (value, max = 160) =>
      String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const selectorFor = (el) => {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute('name')) return `[name="${el.getAttribute('name')}"]`;
      if (el.className && String(el.className).trim()) {
        const firstClass = String(el.className).trim().split(/\s+/)[0];
        if (firstClass) return `.${firstClass}`;
      }
      return el.tagName.toLowerCase();
    };

    const xpathFor = (el) => {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1) {
        let idx = 1;
        let sib = node.previousElementSibling;
        while (sib) {
          if (sib.tagName === node.tagName) idx += 1;
          sib = sib.previousElementSibling;
        }
        parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
        node = node.parentElement;
      }
      return `//${parts.join('/')}`;
    };

    const elInfo = (el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.getAttribute('type') || '').toLowerCase(),
        role: el.getAttribute('role') || '',
        text: cleanText(el.innerText || el.textContent || el.value || '', 140),
        href: el.href || el.getAttribute('href') || '',
        src: el.src || el.currentSrc || el.getAttribute('src') || '',
        selector: selectorFor(el),
        xpath: xpathFor(el),
        id: el.id || '',
        classes: cleanText(el.className || '', 120),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        width: Math.round(r.width),
        height: Math.round(r.height),
        visible: isVisible(el),
        frame_path: 'root',
      };
    };

    const mainSelectors = ['main', 'article', '[class*="content"]', '[class*="main"]', '[id*="content"]', 'section'];
    const mainEl = mainSelectors.map((selector) => document.querySelector(selector)).find(Boolean) || document.body;

    const contentLinks = [];
    mainEl.querySelectorAll('a[href]').forEach((a) => {
      if (!isVisible(a)) return;
      const href = a.href || a.getAttribute('href') || '';
      if (!href || href.includes('#')) return;
      contentLinks.push(elInfo(a));
    });

    const navLinks = [];
    document.querySelectorAll('nav a, header a, [class*="nav"] a, [class*="menu"] a').forEach((a) => {
      if (!isVisible(a)) return;
      navLinks.push(elInfo(a));
    });

    const buttons = [];
    document.querySelectorAll('button, [role="tab"], [class*="tab"], [class*="filter"], [class*="btn"], select').forEach((el) => {
      if (!isVisible(el)) return;
      buttons.push({
        ...elInfo(el),
        kind: el.tagName.toLowerCase() === 'select' ? 'dropdown' : 'button',
        active: el.classList.contains('active') || el.getAttribute('aria-selected') === 'true',
        data: {
          server: el.dataset?.server || null,
          source: el.dataset?.source || null,
          embed: el.dataset?.embed || null,
        },
      });
    });

    const iframes = [];
    document.querySelectorAll('iframe').forEach((frame) => {
      const r = frame.getBoundingClientRect();
      iframes.push({
        src: frame.src || frame.getAttribute('data-src') || '',
        id: frame.id || '',
        name: frame.name || '',
        selector: selectorFor(frame),
        xpath: xpathFor(frame),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        width: Math.round(r.width),
        height: Math.round(r.height),
        category: (frame.src || '').match(/ad|banner|track|analytics/i) ? 'ad' : 'content',
      });
    });

    const playerLibrariesDetail = {
      jwplayer: Boolean(window.jwplayer),
      videojs: Boolean(window.videojs),
      hls: Boolean(window.Hls),
      dashjs: Boolean(window.dashjs),
      html_player_hint: Boolean(document.querySelector('[class*="jwplayer"],[class*="vjs-"],[id*="player"]')),
    };

    const videos = Array.from(document.querySelectorAll('video')).map((video, index) => {
      const r = video.getBoundingClientRect();
      return {
        selector: video.id ? `#${video.id}` : `video:nth-of-type(${index + 1})`,
        xpath: `(//video)[${index + 1}]`,
        src: video.currentSrc || video.src || '',
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    });

    const playerIframe = iframes.find((frame) => frame.category === 'content' && frame.width > 300);
    const hosting_signals = {
      has_video: videos.length > 0,
      has_player_iframe: Boolean(playerIframe),
      player_iframe_src: playerIframe?.src || null,
      visible_content_iframes: iframes.filter((frame) => frame.category === 'content' && frame.width > 100).length,
      player_libraries: Object.values(playerLibrariesDetail).some(Boolean),
      player_libraries_detail: playerLibrariesDetail,
      server_tabs: Boolean(document.querySelector('[class*="server"],[data-server],[data-source]')),
    };

    const popups = [];
    document.querySelectorAll('[class*="popup"],[class*="modal"],[class*="overlay"],[class*="cookie"],[class*="banner"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 200 || r.height <= 0) return;
      if (!isVisible(el)) return;
      const close = el.querySelector('[class*="close"],[class*="accept"],[aria-label*="close"]');
      popups.push({
        selector: selectorFor(el),
        xpath: xpathFor(el),
        text: cleanText(el.innerText || el.textContent || '', 120),
        close_selector: close ? selectorFor(close) : null,
        close_xpath: close ? xpathFor(close) : null,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    });

    const dom_skeleton = [];
    document.querySelectorAll('header, nav, main, section, aside, footer, [class*="content"]').forEach((el) => {
      dom_skeleton.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        classes: cleanText(el.className || '', 80),
        links: el.querySelectorAll('a').length,
      });
    });

    const paginationEl = document.querySelector('[class*="pagination"],[class*="pager"],[aria-label*="pagination"]');
    const pagination = {
      detected: Boolean(paginationEl),
      type: paginationEl ? 'numbered' : null,
      elements: paginationEl
        ? Array.from(paginationEl.querySelectorAll('a,button')).map((el) => {
          const info = elInfo(el);
          return {
            text: info.text,
            href: info.href,
            selector: info.selector,
            xpath: info.xpath,
            x: info.x,
            y: info.y,
          };
        })
        : [],
    };

    const elements = [];
    const tags = 'a,button,input,textarea,select,[role="button"],[onclick],[data-server],[data-source],[data-embed],label';
    document.querySelectorAll(tags).forEach((el) => {
      if (!isVisible(el)) return;
      elements.push({
        ...elInfo(el),
        kind: (() => {
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'select') return 'select';
          if (tag === 'textarea') return 'textarea';
          if (tag === 'input') {
            const inputType = (el.getAttribute('type') || 'text').toLowerCase();
            if (inputType === 'checkbox') return 'checkbox';
            if (inputType === 'radio') return 'radio';
            return 'input';
          }
          if ((el.getAttribute('role') || '').toLowerCase() === 'button') return 'button';
          return tag;
        })(),
        active: el.classList.contains('active') || el.getAttribute('aria-selected') === 'true',
        checked: typeof el.checked === 'boolean' ? Boolean(el.checked) : null,
        disabled: Boolean(el.disabled),
        data: {
          server: el.dataset?.server || null,
          source: el.dataset?.source || null,
          embed: el.dataset?.embed || null,
        },
      });
    });

    return {
      contentLinks: contentLinks.slice(0, limits.contentLinks),
      navLinks: navLinks.slice(0, limits.navLinks),
      buttons: buttons.slice(0, limits.buttons),
      iframes: iframes.slice(0, limits.iframes),
      hosting_signals,
      popups: popups.slice(0, limits.popups),
      dom_skeleton: dom_skeleton.slice(0, 30),
      pagination: {
        ...pagination,
        elements: pagination.elements.slice(0, limits.paginationElements),
      },
      videos: videos.slice(0, limits.videos),
      elements: elements.slice(0, limits.elements),
      text_sample: cleanText(document.body?.innerText || '', 320),
      html_size: (document.documentElement?.outerHTML || '').length,
      node_count: document.querySelectorAll('*').length,
    };
  }, LIMITS);
}

async function collectFrameSummary(frame, framePath, offset) {
  try {
    const summary = await frame.evaluate((limits) => {
      const cleanText = (value, max = 160) =>
        String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const selectorFor = (el) => {
        if (el.id) return `#${el.id}`;
        if (el.getAttribute('name')) return `[name="${el.getAttribute('name')}"]`;
        if (el.className && String(el.className).trim()) {
          const firstClass = String(el.className).trim().split(/\s+/)[0];
          if (firstClass) return `.${firstClass}`;
        }
        return el.tagName.toLowerCase();
      };

      const xpathFor = (el) => {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1) {
          let idx = 1;
          let sib = node.previousElementSibling;
          while (sib) {
            if (sib.tagName === node.tagName) idx += 1;
            sib = sib.previousElementSibling;
          }
          parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
          node = node.parentElement;
        }
        return `//${parts.join('/')}`;
      };

      const info = (el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: cleanText(el.innerText || el.textContent || el.value || '', 120),
          href: el.href || el.getAttribute('href') || '',
          selector: selectorFor(el),
          xpath: xpathFor(el),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      };

      const allLinks = Array.from(document.querySelectorAll('a[href]')).filter((el) => isVisible(el));
      const allButtons = Array.from(document.querySelectorAll('button,[role="button"],select,[class*="tab"],[data-server],[data-source]')).filter((el) => isVisible(el));
      const videos = Array.from(document.querySelectorAll('video'));

      const playerLibrariesDetail = {
        jwplayer: Boolean(window.jwplayer),
        videojs: Boolean(window.videojs),
        hls: Boolean(window.Hls),
        dashjs: Boolean(window.dashjs),
      };

      return {
        title: cleanText(document.title || '', 120),
        text_sample: cleanText(document.body?.innerText || '', 240),
        total_links: allLinks.length,
        total_buttons: allButtons.length,
        total_iframes: document.querySelectorAll('iframe').length,
        video_count: videos.length,
        has_server_controls: Boolean(document.querySelector('[class*="server"],[data-server],[data-source]')),
        has_player_library: Object.values(playerLibrariesDetail).some(Boolean),
        player_libraries_detail: playerLibrariesDetail,
        sample_links: allLinks.slice(0, limits.frameSampleLinks).map(info),
        sample_buttons: allButtons.slice(0, limits.frameSampleButtons).map(info),
      };
    }, LIMITS);

    return {
      ...summary,
      sample_links: summary.sample_links.map((entry) => applyOffset(entry, offset, framePath)),
      sample_buttons: summary.sample_buttons.map((entry) => applyOffset(entry, offset, framePath)),
      error: null,
    };
  } catch (error) {
    return {
      title: '',
      text_sample: '',
      total_links: 0,
      total_buttons: 0,
      total_iframes: 0,
      video_count: 0,
      has_server_controls: false,
      has_player_library: false,
      player_libraries_detail: {},
      sample_links: [],
      sample_buttons: [],
      error: String(error?.message || error || 'frame_evaluate_failed'),
    };
  }
}

/**
 * @param {{ browserWsEndpoint?: string|object }} params
 */
export async function inspect({ browserWsEndpoint, scanMode = 'default' } = {}) {
  return withBrowserSession(browserWsEndpoint, async ({ page }) => {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const lazy_load_warmup = scanMode === 'landing' ? await warmLandingLazyContent(page) : null;
    const rootData = await collectRootData(page);

    const framePathMap = buildFramePathMap(page);
    const frameRecords = [];
    const frames = page.frames().slice(0, LIMITS.frameTree);

    for (const frame of frames) {
      const framePath = framePathMap.get(frame) || 'root';
      const parentFrame = frame.parentFrame();
      const parentPath = parentFrame ? (framePathMap.get(parentFrame) || 'root') : null;
      const offset = await computeFrameOffset(frame);
      const summary = await collectFrameSummary(frame, framePath, offset);

      frameRecords.push({
        frame_path: framePath,
        parent_frame_path: parentPath,
        depth: frameDepth(framePath),
        is_main_frame: frame === page.mainFrame(),
        name: clean(frame.name?.() || '', 60),
        url: frame.url() || '',
        viewport_offset: offset,
        title: summary.title,
        text_sample: summary.text_sample,
        text_hash: textHash(summary.text_sample),
        total_links: summary.total_links,
        total_buttons: summary.total_buttons,
        total_iframes: summary.total_iframes,
        video_count: summary.video_count,
        has_server_controls: summary.has_server_controls,
        has_player_library: summary.has_player_library,
        player_libraries_detail: summary.player_libraries_detail,
        purpose_hint: inferFramePurpose(summary, frame.url()),
        sample_links: summary.sample_links,
        sample_buttons: summary.sample_buttons,
        error: summary.error,
      });
    }

    // ── Screenshot ────────────────────────────────────────────────────────────
    let screenshot_url = null;
    try {
      screenshot_url = await screenshotViewport(page);
    } catch (e) {
      screenshot_url = `error: ${e.message}`;
    }

    return {
      url,
      title,
      screenshot_url,
      contentLinks: rootData.contentLinks,
      navLinks: rootData.navLinks,
      buttons: rootData.buttons,
      iframes: rootData.iframes,
      hosting_signals: rootData.hosting_signals,
      popups: rootData.popups,
      dom_skeleton: rootData.dom_skeleton,
      pagination: rootData.pagination,
      videos: rootData.videos,
      elements: rootData.elements,
      frame_tree: frameRecords,
      lazy_load_warmup,
      page_digest: {
        text_sample: rootData.text_sample,
        text_hash: textHash(rootData.text_sample),
        html_size: rootData.html_size,
        node_count: rootData.node_count,
      },
      stats: {
        content_links: rootData.contentLinks.length,
        nav_links: rootData.navLinks.length,
        buttons: rootData.buttons.length,
        iframes: rootData.iframes.length,
        videos: rootData.videos.length,
        popups: rootData.popups.length,
        elements: rootData.elements.length,
        frames_total: frameRecords.length,
        frames_with_video: frameRecords.filter((frame) => frame.video_count > 0).length,
        lazy_load_clicks: Number(lazy_load_warmup?.clicked || 0),
        lazy_load_scroll_steps: Number(lazy_load_warmup?.scroll_steps || 0),
      },
    };
  });
}
