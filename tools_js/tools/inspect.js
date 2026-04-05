/**
 * tools/inspect.js — Full DOM scan + player signal detection + screenshot.
 *
 * Returns a rich object the LLM uses to understand the page:
 *   content_links, content_cards, nav_links, buttons, iframes,
 *   hosting_signals, pagination, dom_skeleton, screenshot_url
 */

import { connectBrowser, getPage } from '../shared/browser.js';
import { screenshotViewport } from '../shared/screenshot.js';

/**
 * @param {{ browserWsEndpoint?: string }} params
 */
export async function inspect({ browserWsEndpoint } = {}) {
  const browser = await connectBrowser(browserWsEndpoint);
  const page    = await getPage(browser);

  // ── Basic info ────────────────────────────────────────────────────────────
  const url   = page.url();
  const title = await page.title();

  // ── DOM extraction via page.evaluate ────────────────────────────────────
  const domData = await page.evaluate(() => {
    const isVisible = el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const elInfo = (el) => ({
      tag:       el.tagName.toLowerCase(),
      text:      (el.innerText || el.textContent || '').trim().slice(0, 150),
      href:      el.href || el.getAttribute('href') || '',
      src:       el.src || el.currentSrc || el.getAttribute('src') || '',
      selector:  el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : el.tagName.toLowerCase(),
      xpath:     (() => {
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1) {
          let idx = 1;
          let sib = node.previousElementSibling;
          while (sib) { if (sib.tagName === node.tagName) idx++; sib = sib.previousElementSibling; }
          parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
          node = node.parentElement;
        }
        return '//' + parts.join('/');
      })(),
      id:        el.id || '',
      classes:   el.className?.toString().trim().slice(0, 80) || '',
      x:         Math.round(el.getBoundingClientRect().x + el.getBoundingClientRect().width / 2),
      y:         Math.round(el.getBoundingClientRect().y + el.getBoundingClientRect().height / 2),
      visible:   (() => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })(),
      in_iframe: false,
    });

    // Content links (main content area — not nav/footer)
    const contentLinks = [];
    const mainSelectors = ['main', 'article', '[class*="content"]', '[class*="main"]', '[id*="content"]', 'section'];
    const mainEl = mainSelectors.map(s => document.querySelector(s)).find(Boolean) || document.body;
    mainEl.querySelectorAll('a[href]').forEach(a => {
      if (isVisible(a) && a.href && !a.href.includes('#')) contentLinks.push(elInfo(a));
    });

    // Navigation links
    const navLinks = [];
    document.querySelectorAll('nav a, header a, [class*="nav"] a, [class*="menu"] a').forEach(a => {
      if (isVisible(a)) navLinks.push(elInfo(a));
    });

    // Interactive buttons / tabs / dropdowns
    const buttons = [];
    document.querySelectorAll('button, [role="tab"], [class*="tab"], [class*="filter"], [class*="btn"], select').forEach(el => {
      if (isVisible(el)) buttons.push({
        ...elInfo(el),
        type: el.tagName.toLowerCase() === 'select' ? 'dropdown' : 'button',
        active: el.classList.contains('active') || el.getAttribute('aria-selected') === 'true',
      });
    });

    // Iframes
    const iframes = [];
    document.querySelectorAll('iframe').forEach(f => {
      const r = f.getBoundingClientRect();
      iframes.push({
        src: f.src || f.getAttribute('data-src') || '',
        id: f.id || '',
        name: f.name || '',
        width: Math.round(r.width),
        height: Math.round(r.height),
        category: (f.src || '').match(/ad|banner|track|analytics/i) ? 'ad' : 'content',
      });
    });

    // Hosting signals
    const videos = Array.from(document.querySelectorAll('video'));
    const playerIframe = iframes.find(f => f.category === 'content' && f.width > 300);
    const hosting_signals = {
      has_video: videos.length > 0,
      has_player_iframe: !!playerIframe,
      player_iframe_src: playerIframe?.src || null,
      visible_content_iframes: iframes.filter(f => f.category === 'content' && f.width > 100).length,
      player_libraries: !!(
        window.jwplayer || window.videojs || window.Hls || window.dashjs
        || document.querySelector('[class*="jwplayer"],[class*="vjs-"],[id*="player"]')
      ),
      server_tabs: !!document.querySelector('[class*="server"],[data-server],[data-source]'),
    };

    // Popups / overlays
    const popups = [];
    document.querySelectorAll('[class*="popup"],[class*="modal"],[class*="overlay"],[class*="cookie"],[class*="banner"]').forEach(el => {
      if (isVisible(el) && el.getBoundingClientRect().width > 200) {
        const close = el.querySelector('[class*="close"],[class*="accept"],[aria-label*="close"]');
        popups.push({
          selector: el.id ? `#${el.id}` : `.${el.className.split(' ')[0]}`,
          close_selector: close ? (close.id ? `#${close.id}` : `.${close.className.split(' ')[0]}`) : null,
        });
      }
    });

    // DOM skeleton
    const dom_skeleton = (() => {
      const sections = [];
      document.querySelectorAll('header, nav, main, section, aside, footer, [class*="content"]').forEach(el => {
        sections.push({ tag: el.tagName.toLowerCase(), id: el.id, links: el.querySelectorAll('a').length });
      });
      return sections;
    })();

    // Pagination
    const paginationEl = document.querySelector('[class*="pagination"],[class*="pager"],[aria-label*="pagination"]');
    const pagination = {
      detected: !!paginationEl,
      type: paginationEl ? 'numbered' : null,
      elements: paginationEl ? Array.from(paginationEl.querySelectorAll('a,button')).map(el => ({
        text: el.innerText.trim(),
        href: el.href || '',
        selector: el.id ? `#${el.id}` : `.${el.className.split(' ')[0]}`,
      })) : [],
    };

    return { contentLinks, navLinks, buttons, iframes, hosting_signals, popups, dom_skeleton, pagination };
  });

  // ── Video elements (need puppeteer, not page.evaluate for some props) ───
  const videos = await page.evaluate(() =>
    Array.from(document.querySelectorAll('video')).map((v, i) => ({
      selector:     v.id ? `#${v.id}` : `video:nth-of-type(${i + 1})`,
      xpath:        `(//video)[${i + 1}]`,
      src:          v.currentSrc || v.src || '',
      readyState:   v.readyState,
      networkState: v.networkState,
      paused:       v.paused,
      duration:     v.duration,
      x:            Math.round(v.getBoundingClientRect().x + v.getBoundingClientRect().width / 2),
      y:            Math.round(v.getBoundingClientRect().y + v.getBoundingClientRect().height / 2),
    }))
  );

  // ── Elements[] — all interactive elements (used by interact tool) ─────
  const elements = await page.evaluate(() => {
    const results = [];
    const tags = 'a,button,input,select,[role="button"],[onclick],[data-server],[data-source],[data-embed]';
    document.querySelectorAll(tags).forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      results.push({
        type:     el.tagName.toLowerCase(),
        text:     (el.innerText || el.textContent || el.value || '').trim().slice(0, 100),
        selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : `${el.tagName.toLowerCase()}:nth-of-type(${i + 1})`,
        xpath:    (() => {
          const parts = [];
          let node = el;
          while (node && node.nodeType === 1) {
            let idx = 1, sib = node.previousElementSibling;
            while (sib) { if (sib.tagName === node.tagName) idx++; sib = sib.previousElementSibling; }
            parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
            node = node.parentElement;
          }
          return '//' + parts.join('/');
        })(),
        href:     el.href || '',
        active:   el.classList.contains('active') || el.getAttribute('aria-selected') === 'true',
        x:        Math.round(r.x + r.width / 2),
        y:        Math.round(r.y + r.height / 2),
        width:    Math.round(r.width),
        height:   Math.round(r.height),
        data:     {
          server: el.dataset?.server || null,
          source: el.dataset?.source || null,
          embed:  el.dataset?.embed  || null,
        },
      });
    });
    return results;
  });

  // ── Screenshot ────────────────────────────────────────────────────────────
  let screenshot_url = null;
  try {
    screenshot_url = await screenshotViewport(page);
  } catch (e) {
    screenshot_url = `error: ${e.message}`;
  }

  await browser.disconnect();

  return {
    url,
    title,
    screenshot_url,
    videos,
    elements,
    ...domData,
    stats: {
      content_links: domData.contentLinks.length,
      nav_links:     domData.navLinks.length,
      buttons:       domData.buttons.length,
      iframes:       domData.iframes.length,
      videos:        videos.length,
      popups:        domData.popups.length,
    },
  };
}
