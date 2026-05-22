/**
 * tools/inspect.js - Full DOM scan + player signal detection + screenshot.
 *
 * Returns structured, high-ceiling context used by profile-specific inspect tools.
 */

import { connectBrowser, getPage } from "../shared/browser.js";
import { screenshotViewport } from "../shared/screenshot.js";

const LIMITS = {
  contentLinks: 1200,
  navLinks: 500,
  buttons: 800,
  iframes: 220,
  popups: 80,
  paginationElements: 120,
  videos: 180,
  elements: 1600,
  revealControls: 240,
  collapsedSections: 120,
  hiddenLinkSamples: 12,
  frameTree: 180,
  frameSampleLinks: 180,
  frameSampleButtons: 180,
};

const clean = (value, max = 160) =>
  String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

async function warmLazyContent(page, { scanMode = "default", scrollSteps = 12 } = {}) {
  const effectiveSteps = Math.max(1, Math.min(Number(scrollSteps || 12), 40));
  return page
    .evaluate(
      async ({ mode, maxSteps }) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const visible = (el) => {
          if (!(el instanceof Element)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        };

        const scrollStep = Math.max(Math.floor(window.innerHeight * 0.85), 360);
        const clickLabels = [];
        const clickSelectors = [
          "button",
          "a[href]",
          "[role='button']",
          "[data-action]",
          "[data-testid]",
          "[class*='more']",
          "[class*='load']",
          "[class*='show']",
          "[class*='next']",
          "[aria-expanded]",
          "[aria-controls]",
          "[data-toggle]",
          "[data-bs-toggle]",
          "summary",
        ].join(",");
        const clickPattern =
          /(load more|show more|view more|see more|more matches|more events|more streams|expand|show all|view all|more channels|channels|live tv|tv guide|filter|menu|dropdown|accordion|open|next)/i;
        let scrollCount = 0;
        let clicked = 0;
        const initialHeight = Math.max(
          document.body?.scrollHeight || 0,
          document.documentElement?.scrollHeight || 0,
        );

        for (let pass = 0; pass < 4; pass += 1) {
          const clickCandidates = Array.from(document.querySelectorAll(clickSelectors))
            .filter(visible)
            .filter((node) => {
              const href = node.getAttribute("href") || "";
              const ariaExpanded = node.getAttribute("aria-expanded");
              const hasSamePageTarget =
                !href ||
                href.startsWith("#") ||
                /^javascript:/i.test(href) ||
                Boolean(node.getAttribute("aria-controls")) ||
                Boolean(node.getAttribute("data-toggle")) ||
                Boolean(node.getAttribute("data-bs-toggle")) ||
                ariaExpanded !== null ||
                node.tagName.toLowerCase() === "summary";
              if (!hasSamePageTarget) return false;

              const haystack = (
                node.innerText ||
                node.textContent ||
                node.getAttribute("aria-label") ||
                node.getAttribute("title") ||
                node.id ||
                node.className ||
                ""
              ).trim();
              return clickPattern.test(haystack) || ariaExpanded === "false";
            })
            .slice(0, 20);

          for (const node of clickCandidates) {
            try {
              node.scrollIntoView({ block: "center", inline: "nearest" });
              await sleep(120);
              node.click();
              clicked += 1;
              clickLabels.push(
                (
                  node.innerText ||
                  node.textContent ||
                  node.getAttribute("aria-label") ||
                  ""
                )
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 120),
              );
              await sleep(260);
            } catch {
              // ignore
            }
          }

          const interestingSections = Array.from(
            document.querySelectorAll(
              "main section, main article, [class*='match'], [class*='event'], [class*='card'], [class*='player'], [data-testid*='card'], [data-testid*='match']",
            ),
          )
            .filter(visible)
            .slice(0, mode === "landing" ? 60 : 35);

          for (const section of interestingSections) {
            try {
              section.scrollIntoView({ block: "center", inline: "nearest" });
              await sleep(80);
            } catch {
              // ignore
            }
          }

          let dynamicHeight = Math.max(
            document.body?.scrollHeight || 0,
            document.documentElement?.scrollHeight || 0,
          );
          while (window.scrollY + window.innerHeight < dynamicHeight - 24) {
            window.scrollBy({ top: scrollStep, left: 0, behavior: "instant" });
            scrollCount += 1;
            await sleep(mode === "landing" ? 170 : 190);
            dynamicHeight = Math.max(
              document.body?.scrollHeight || 0,
              document.documentElement?.scrollHeight || 0,
            );
            if (scrollCount >= maxSteps) break;
          }
          await sleep(260);
          if (scrollCount >= maxSteps) break;
        }

        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
        await sleep(180);

        return {
          clicked,
          click_labels: clickLabels,
          scroll_steps: scrollCount,
          initial_height: initialHeight,
          final_height: Math.max(
            document.body?.scrollHeight || 0,
            document.documentElement?.scrollHeight || 0,
          ),
          reset_to_top: Math.round(window.scrollY || 0) === 0,
        };
      },
      { mode: scanMode, maxSteps: effectiveSteps },
    )
    .catch(() => ({
      clicked: 0,
      click_labels: [],
      scroll_steps: 0,
      initial_height: 0,
      final_height: 0,
      reset_to_top: true,
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

function frameDepth(framePath) {
  if (!framePath || framePath === "root") return 0;
  return framePath.split(".").length - 1;
}

function buildFramePathMap(page) {
  const map = new Map();
  const root = page.mainFrame();
  map.set(root, "root");

  const queue = [root];
  while (queue.length) {
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

function applyOffset(entry, offset, framePath) {
  return {
    ...entry,
    x: Math.round((entry.x || 0) + offset.x),
    y: Math.round((entry.y || 0) + offset.y),
    frame_path: framePath,
  };
}

function inferFramePurpose(summary, url) {
  const haystack = `${summary.title || ""} ${summary.text_sample || ""} ${url || ""}`.toLowerCase();

  if (summary.video_count > 0 || summary.has_player_library) return "player";
  if (summary.has_server_controls) return "server-controls";
  if (/embed|player|iframe|stream/.test(haystack)) return "player";
  if (/match|fixture|schedule|channels|league/.test(haystack)) return "listing";
  if (/ad|banner|doubleclick|analytics|track/.test(haystack)) return "ad";
  return "unknown";
}

async function collectRootData(page) {
  return page.evaluate((limits) => {
    const cleanText = (value, max = 160) =>
      String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    const selectorFor = (el) => {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute("name")) return `[name="${el.getAttribute("name")}"]`;
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
      return `//${parts.join("/")}`;
    };

    const elInfo = (el) => {
      const r = el.getBoundingClientRect();
      const parentText = cleanText(el.parentElement?.innerText || el.parentElement?.textContent || "", 220);
      const section = el.closest?.("section,article,main,table,tbody,ul,ol,[class*='content'],[class*='schedule'],[class*='event'],[class*='match']");
      const sectionHeading =
        section?.querySelector?.("h1,h2,h3,h4,[class*='title'],[class*='heading'],thead") || null;
      return {
        text: cleanText(el.innerText || el.textContent || el.value || "", 140),
        nearby_text: parentText,
        section_title: cleanText(sectionHeading?.innerText || sectionHeading?.textContent || "", 120),
        href: el.href || el.getAttribute("href") || "",
        src: el.src || el.currentSrc || el.getAttribute("src") || "",
        selector: selectorFor(el),
        xpath: xpathFor(el),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        frame_path: "root",
        visible: isVisible(el),
      };
    };

    const dedupeBy = (items, keyFn) => {
      const seen = new Set();
      const result = [];
      for (const item of items || []) {
        const key = keyFn(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(item);
      }
      return result;
    };

    const linkSamples = (root, sampleLimit = 8) =>
      Array.from(root?.querySelectorAll?.("a[href]") || [])
        .map((link) => elInfo(link))
        .filter((link) => link.href && !/^javascript:/i.test(link.href))
        .slice(0, sampleLimit);

    const findControlledRegion = (control) => {
      const rawTargets = [
        control.getAttribute("aria-controls"),
        control.getAttribute("data-target"),
        control.getAttribute("data-bs-target"),
        control.getAttribute("href"),
      ].filter(Boolean);

      for (const raw of rawTargets) {
        const value = String(raw).trim();
        const id = value.startsWith("#") ? value.slice(1) : value;
        if (!id || /^(javascript:|https?:)/i.test(value)) continue;
        try {
          const target =
            document.getElementById(id) ||
            (value.startsWith("#") ? document.querySelector(value) : null);
          if (target) return target;
        } catch {
          // ignore invalid selector fragments
        }
      }

      if (control.tagName.toLowerCase() === "summary" && control.parentElement) {
        return control.parentElement;
      }

      let sibling = control.nextElementSibling;
      for (let hops = 0; sibling && hops < 3; hops += 1) {
        if (
          sibling.querySelector?.("a[href],button,[role='button'],[onclick]") ||
          /collapse|accordion|dropdown|menu|panel|content/i.test(
            `${sibling.id || ""} ${sibling.className || ""}`,
          )
        ) {
          return sibling;
        }
        sibling = sibling.nextElementSibling;
      }

      return control.closest?.(
        "[class*='accordion'],[class*='collapse'],[class*='dropdown'],[class*='menu'],[class*='tab'],[class*='filter'],details",
      );
    };

    const controlState = (control, region = null) => {
      const ariaExpanded = control.getAttribute("aria-expanded");
      if (ariaExpanded === "false") return "collapsed";
      if (ariaExpanded === "true") return "expanded";
      if (control.tagName.toLowerCase() === "summary") {
        return control.parentElement?.hasAttribute("open") ? "expanded" : "collapsed";
      }
      if (region) {
        const hidden =
          region.hasAttribute("hidden") ||
          region.getAttribute("aria-hidden") === "true" ||
          !isVisible(region);
        return hidden ? "collapsed" : "unknown";
      }
      return "unknown";
    };

    const revealPattern =
      /(show|more|load|view|see|expand|collapse|toggle|open|close|next|older|channels?|live tv|tv guide|filter|menu|dropdown|accordion|tab|league|sport|category|server|source)/i;

    const mainSelectors = [
      "main",
      "article",
      "[class*='content']",
      "[class*='main']",
      "[id*='content']",
      "section",
    ];
    const mainEl =
      mainSelectors
        .map((selector) => document.querySelector(selector))
        .find(Boolean) || document.body;

    const contentLinks = [];
    mainEl.querySelectorAll("a[href]").forEach((a) => {
      if (!isVisible(a)) return;
      const href = a.href || a.getAttribute("href") || "";
      if (!href || href.includes("#")) return;
      contentLinks.push(elInfo(a));
    });

    const navLinks = [];
    document
      .querySelectorAll("nav a, header a, [class*='nav'] a, [class*='menu'] a")
      .forEach((a) => {
        if (!isVisible(a)) return;
        navLinks.push(elInfo(a));
      });

    const buttons = [];
    document
      .querySelectorAll(
        "button, [role='tab'], [class*='tab'], [class*='filter'], [class*='btn'], select",
      )
      .forEach((el) => {
        if (!isVisible(el)) return;
        buttons.push({
          ...elInfo(el),
          kind: el.tagName.toLowerCase() === "select" ? "dropdown" : "button",
          active:
            el.classList.contains("active") ||
            el.getAttribute("aria-selected") === "true",
          data: {
            server: el.dataset?.server || null,
            source: el.dataset?.source || null,
            embed: el.dataset?.embed || null,
          },
        });
      });

    const iframes = [];
    document.querySelectorAll("iframe").forEach((frame) => {
      const r = frame.getBoundingClientRect();
      iframes.push({
        src: frame.src || frame.getAttribute("data-src") || "",
        id: frame.id || "",
        name: frame.name || "",
        selector: selectorFor(frame),
        xpath: xpathFor(frame),
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
        category: (frame.src || "").match(/ad|banner|track|analytics/i)
          ? "ad"
          : "content",
        area: Math.round(r.width * r.height),
      });
    });

    const playerLibrariesDetail = {
      jwplayer: Boolean(window.jwplayer),
      videojs: Boolean(window.videojs),
      hls: Boolean(window.Hls),
      dashjs: Boolean(window.dashjs),
      html_player_hint: Boolean(
        document.querySelector("[class*='jwplayer'],[class*='vjs-'],[id*='player']"),
      ),
    };

    const videos = Array.from(document.querySelectorAll("video")).map((video, index) => {
      const r = video.getBoundingClientRect();
      const sources = Array.from(video.querySelectorAll("source"))
        .map((source) => source.src || source.getAttribute("src") || "")
        .filter(Boolean);
      return {
        selector: video.id ? `#${video.id}` : `video:nth-of-type(${index + 1})`,
        xpath: `(//video)[${index + 1}]`,
        src: video.currentSrc || video.src || sources[0] || "",
        sources,
        readyState: video.readyState,
        networkState: video.networkState,
        paused: video.paused,
        duration: Number.isFinite(video.duration)
          ? Number(video.duration.toFixed(2))
          : null,
        x: Math.round(r.x + r.width / 2),
        y: Math.round(r.y + r.height / 2),
      };
    });

    const playerIframe = iframes.find(
      (frame) => frame.category === "content" && frame.area > 300 * 160,
    );
    const hosting_signals = {
      has_video: videos.length > 0,
      has_player_iframe: Boolean(playerIframe),
      player_iframe_src: playerIframe?.src || null,
      visible_content_iframes: iframes.filter(
        (frame) => frame.category === "content" && frame.area > 100 * 80,
      ).length,
      player_libraries: Object.values(playerLibrariesDetail).some(Boolean),
      player_libraries_detail: playerLibrariesDetail,
      server_tabs: Boolean(
        document.querySelector("[class*='server'],[data-server],[data-source]"),
      ),
    };

    const popups = [];
    document
      .querySelectorAll(
        "[class*='popup'],[class*='modal'],[class*='overlay'],[class*='cookie'],[class*='banner']",
      )
      .forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 200 || r.height <= 0) return;
        if (!isVisible(el)) return;
        const close = el.querySelector(
          "[class*='close'],[class*='accept'],[aria-label*='close']",
        );
        popups.push({
          selector: selectorFor(el),
          xpath: xpathFor(el),
          text: cleanText(el.innerText || el.textContent || "", 120),
          close_selector: close ? selectorFor(close) : null,
          close_xpath: close ? xpathFor(close) : null,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        });
      });

    const dom_skeleton = [];
    document
      .querySelectorAll("header, nav, main, section, aside, footer, [class*='content']")
      .forEach((el) => {
        dom_skeleton.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          links: el.querySelectorAll("a").length,
        });
      });

    const paginationEl = document.querySelector(
      "[class*='pagination'],[class*='pager'],[aria-label*='pagination']",
    );
    const pagination = {
      detected: Boolean(paginationEl),
      type: paginationEl ? "numbered" : null,
      elements: paginationEl
        ? Array.from(paginationEl.querySelectorAll("a,button")).map((el) => {
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
    pagination.elements = dedupeBy(
      pagination.elements,
      (item) => `${item.href}|${item.text}|${item.selector}|${item.xpath}`,
    );

    const elements = [];
    const tags =
      "a,button,input,textarea,select,[role='button'],[onclick],[data-server],[data-source],[data-embed],label";
    document.querySelectorAll(tags).forEach((el) => {
      if (!isVisible(el)) return;
      elements.push({
        ...elInfo(el),
        kind: (() => {
          const tag = el.tagName.toLowerCase();
          if (tag === "a") return "link";
          if (tag === "button") return "button";
          if (tag === "select") return "select";
          if (tag === "textarea") return "textarea";
          if (tag === "input") {
            const inputType = (el.getAttribute("type") || "text").toLowerCase();
            if (inputType === "checkbox") return "checkbox";
            if (inputType === "radio") return "radio";
            return "input";
          }
          if ((el.getAttribute("role") || "").toLowerCase() === "button")
            return "button";
          return tag;
        })(),
        active:
          el.classList.contains("active") ||
          el.getAttribute("aria-selected") === "true",
        checked: typeof el.checked === "boolean" ? Boolean(el.checked) : null,
        disabled: Boolean(el.disabled),
        data: {
          server: el.dataset?.server || null,
          source: el.dataset?.source || null,
          embed: el.dataset?.embed || null,
        },
      });
    });

    const reveal_controls = [];
    document
      .querySelectorAll(
        [
          "button",
          "a[href]",
          "summary",
          "[role='button']",
          "[role='tab']",
          "[aria-expanded]",
          "[aria-controls]",
          "[data-toggle]",
          "[data-bs-toggle]",
          "[data-action]",
          "[onclick]",
          "[class*='tab']",
          "[class*='filter']",
          "[class*='more']",
          "[class*='load']",
          "[class*='show']",
        ].join(","),
      )
      .forEach((el) => {
        if (!isVisible(el)) return;
        const attrsText = [
          el.innerText,
          el.textContent,
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
          el.getAttribute("aria-controls"),
          el.getAttribute("data-toggle"),
          el.getAttribute("data-bs-toggle"),
          el.getAttribute("data-action"),
          el.id,
          el.className,
        ]
          .filter(Boolean)
          .join(" ");
        const isReveal =
          revealPattern.test(attrsText) ||
          el.getAttribute("aria-expanded") !== null ||
          el.getAttribute("aria-controls") ||
          el.getAttribute("data-toggle") ||
          el.getAttribute("data-bs-toggle") ||
          el.tagName.toLowerCase() === "summary";
        if (!isReveal) return;

        const region = findControlledRegion(el);
        const samples = linkSamples(region || el.parentElement || el, 6);
        const hiddenLinkCount = samples.filter((link) => !link.visible).length;
        const info = elInfo(el);
        reveal_controls.push({
          ...info,
          kind: "reveal_control",
          state: controlState(el, region),
          sample_links: samples,
          visible_link_count: samples.filter((link) => link.visible).length,
          hidden_link_count: hiddenLinkCount,
          data: {
            aria_expanded: el.getAttribute("aria-expanded"),
            aria_controls: el.getAttribute("aria-controls"),
            data_toggle: el.getAttribute("data-toggle"),
            data_bs_toggle: el.getAttribute("data-bs-toggle"),
            data_target: el.getAttribute("data-target"),
            data_bs_target: el.getAttribute("data-bs-target"),
            reveals_hidden_content: hiddenLinkCount > 0 || controlState(el, region) === "collapsed",
          },
        });
      });

    const collapsed_sections = [];
    document
      .querySelectorAll(
        [
          "details:not([open])",
          "[hidden]",
          "[aria-hidden='true']",
          "[class*='collapse']",
          "[class*='accordion']",
          "[class*='dropdown-menu']",
          "[class*='submenu']",
          "[class*='panel']",
        ].join(","),
      )
      .forEach((section) => {
        const samples = linkSamples(section, limits.hiddenLinkSamples);
        const hiddenLinks = samples.filter((link) => !link.visible);
        const controls = Array.from(
          section.querySelectorAll("button,[role='button'],summary,[onclick]"),
        );
        const sectionText = cleanText(
          section.innerText || section.textContent || section.getAttribute("aria-label") || "",
          140,
        );
        if (!samples.length && !controls.length && !sectionText) return;

        let trigger = null;
        if (section.id) {
          try {
            const escapedId =
              window.CSS && typeof window.CSS.escape === "function"
                ? window.CSS.escape(section.id)
                : String(section.id).replace(/["\\]/g, "\\$&");
            trigger = document.querySelector(`[aria-controls="${escapedId}"],[href="#${escapedId}"]`);
          } catch {
            trigger = null;
          }
        }
        if (!trigger) {
          trigger = section.querySelector("summary,[aria-expanded],button,[role='button'],a[href^='#']");
        }

        collapsed_sections.push({
          selector: selectorFor(section),
          xpath: xpathFor(section),
          text: sectionText,
          state:
            section.hasAttribute("hidden") ||
            section.getAttribute("aria-hidden") === "true" ||
            !isVisible(section)
              ? "collapsed"
              : "unknown",
          link_count: samples.length,
          hidden_link_count: hiddenLinks.length,
          button_count: controls.length,
          sample_links: samples.slice(0, 8),
          hidden_link_samples: hiddenLinks.slice(0, 8),
          reveal_selector: trigger ? selectorFor(trigger) : "",
          reveal_xpath: trigger ? xpathFor(trigger) : "",
        });
      });

    const contentLinksDeduped = dedupeBy(
      contentLinks,
      (item) => `${item.href}|${item.text}|${item.selector}|${item.xpath}`,
    );
    const navLinksDeduped = dedupeBy(
      navLinks,
      (item) => `${item.href}|${item.text}|${item.selector}|${item.xpath}`,
    );
    const buttonsDeduped = dedupeBy(
      buttons,
      (item) =>
        `${item.kind}|${item.text}|${item.selector}|${item.xpath}|${item.data?.server || ""}|${item.data?.source || ""}|${item.data?.embed || ""}`,
    );
    const iframesDeduped = dedupeBy(
      iframes,
      (item) => `${item.src}|${item.selector}|${item.xpath}|${item.category}`,
    );
    const popupsDeduped = dedupeBy(
      popups,
      (item) => `${item.selector}|${item.xpath}|${item.text}|${item.close_selector || ""}`,
    );
    const elementsDeduped = dedupeBy(
      elements,
      (item) =>
        `${item.kind}|${item.text}|${item.href}|${item.src}|${item.selector}|${item.xpath}|${item.data?.server || ""}|${item.data?.source || ""}|${item.data?.embed || ""}`,
    );
    const revealControlsDeduped = dedupeBy(
      reveal_controls,
      (item) => `${item.kind}|${item.text}|${item.selector}|${item.xpath}|${item.state}`,
    );
    const collapsedSectionsDeduped = dedupeBy(
      collapsed_sections,
      (item) => `${item.selector}|${item.xpath}|${item.text}|${item.hidden_link_count}`,
    );
    const videosDeduped = dedupeBy(
      videos,
      (item) => `${item.selector}|${item.xpath}|${item.src}`,
    );
    const domSkeletonDeduped = dedupeBy(
      dom_skeleton,
      (item) => `${item.tag}|${item.id}|${item.links}`,
    );

    return {
      contentLinks: contentLinksDeduped.slice(0, limits.contentLinks),
      navLinks: navLinksDeduped.slice(0, limits.navLinks),
      buttons: buttonsDeduped.slice(0, limits.buttons),
      iframes: iframesDeduped.slice(0, limits.iframes).map(({ area, ...frame }) => frame),
      hosting_signals,
      popups: popupsDeduped.slice(0, limits.popups),
      dom_skeleton: domSkeletonDeduped,
      pagination: {
        ...pagination,
        elements: pagination.elements.slice(0, limits.paginationElements),
      },
      videos: videosDeduped.slice(0, limits.videos),
      elements: elementsDeduped.slice(0, limits.elements),
      reveal_controls: revealControlsDeduped.slice(0, limits.revealControls),
      collapsed_sections: collapsedSectionsDeduped.slice(0, limits.collapsedSections),
      text_sample: cleanText(document.body?.innerText || "", 320),
      html_size: (document.documentElement?.outerHTML || "").length,
      node_count: document.querySelectorAll("*").length,
    };
  }, LIMITS);
}

async function collectFrameSummary(frame, framePath, offset) {
  try {
    const summary = await frame.evaluate((limits) => {
      const cleanText = (value, max = 160) =>
        String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const selectorFor = (el) => {
        if (el.id) return `#${el.id}`;
        if (el.getAttribute("name")) return `[name="${el.getAttribute("name")}"]`;
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
        return `//${parts.join("/")}`;
      };

      const info = (el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: cleanText(el.innerText || el.textContent || el.value || "", 120),
          href: el.href || el.getAttribute("href") || "",
          selector: selectorFor(el),
          xpath: xpathFor(el),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      };

      const allLinks = Array.from(document.querySelectorAll("a[href]")).filter((el) =>
        isVisible(el),
      );
      const allButtons = Array.from(
        document.querySelectorAll(
          "button,[role='button'],select,[class*='tab'],[data-server],[data-source]",
        ),
      ).filter((el) => isVisible(el));
      const videos = Array.from(document.querySelectorAll("video"));
      const sampleVideos = videos.slice(0, 12).map((video, index) => {
        const r = video.getBoundingClientRect();
        const sources = Array.from(video.querySelectorAll("source"))
          .map((source) => source.src || source.getAttribute("src") || "")
          .filter(Boolean);
        return {
          selector: video.id ? `#${video.id}` : `video:nth-of-type(${index + 1})`,
          xpath: `(//video)[${index + 1}]`,
          src: video.currentSrc || video.src || sources[0] || "",
          sources,
          readyState: video.readyState,
          networkState: video.networkState,
          paused: video.paused,
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      });

      const playerLibrariesDetail = {
        jwplayer: Boolean(window.jwplayer),
        videojs: Boolean(window.videojs),
        hls: Boolean(window.Hls),
        dashjs: Boolean(window.dashjs),
      };

      return {
        title: cleanText(document.title || "", 120),
        text_sample: cleanText(document.body?.innerText || "", 240),
        total_links: allLinks.length,
        total_buttons: allButtons.length,
        total_iframes: document.querySelectorAll("iframe").length,
        video_count: videos.length,
        has_server_controls: Boolean(
          document.querySelector("[class*='server'],[data-server],[data-source]"),
        ),
        has_player_library: Object.values(playerLibrariesDetail).some(Boolean),
        player_libraries_detail: playerLibrariesDetail,
        sample_links: allLinks.slice(0, limits.frameSampleLinks).map(info),
        sample_buttons: allButtons.slice(0, limits.frameSampleButtons).map(info),
        sample_videos: sampleVideos,
      };
    }, LIMITS);

    return {
      ...summary,
      sample_links: dedupeBy(
        summary.sample_links.map((entry) => applyOffset(entry, offset, framePath)),
        (entry) => `${entry.href}|${entry.text}|${entry.selector}|${entry.xpath}`,
      ),
      sample_buttons: dedupeBy(
        summary.sample_buttons.map((entry) => applyOffset(entry, offset, framePath)),
        (entry) => `${entry.text}|${entry.selector}|${entry.xpath}`,
      ),
      sample_videos: summary.sample_videos || [],
      error: null,
    };
  } catch (error) {
    return {
      title: "",
      text_sample: "",
      total_links: 0,
      total_buttons: 0,
      total_iframes: 0,
      video_count: 0,
      has_server_controls: false,
      has_player_library: false,
      player_libraries_detail: {},
      sample_links: [],
      sample_buttons: [],
      sample_videos: [],
      error: String(error?.message || error || "frame_evaluate_failed"),
    };
  }
}

export async function inspect({
  browserWsEndpoint,
  scanMode = "default",
  scroll = true,
  scroll_steps = 12,
} = {}) {
  const browser = await connectBrowser(browserWsEndpoint);
  const page = await getPage(browser);

  const url = page.url();
  const title = await page.title().catch(() => "");
  const shouldWarm = scanMode !== "default" || Boolean(scroll);
  const lazy_load_warmup = shouldWarm
    ? await warmLazyContent(page, { scanMode, scrollSteps: scroll_steps })
    : null;
  const rootData = await collectRootData(page);

  const framePathMap = buildFramePathMap(page);
  const frameRecords = [];
  const frames = page.frames().slice(0, LIMITS.frameTree);

  for (const frame of frames) {
    const framePath = framePathMap.get(frame) || "root";
    const parentFrame = frame.parentFrame();
    const parentPath = parentFrame ? framePathMap.get(parentFrame) || "root" : null;
    const offset = await computeFrameOffset(frame);
    const summary = await collectFrameSummary(frame, framePath, offset);

      frameRecords.push({
      frame_path: framePath,
      parent_frame_path: parentPath,
      depth: frameDepth(framePath),
      is_main_frame: frame === page.mainFrame(),
      url: frame.url() || "",
      total_links: summary.total_links,
      total_buttons: summary.total_buttons,
      total_iframes: summary.total_iframes,
      video_count: summary.video_count,
      has_server_controls: summary.has_server_controls,
      has_player_library: summary.has_player_library,
      purpose_hint: inferFramePurpose(summary, frame.url()),
      sample_links: summary.sample_links,
      sample_buttons: summary.sample_buttons,
      sample_videos: summary.sample_videos || [],
      error: summary.error,
    });
  }

  const frameRecordsDeduped = dedupeBy(
    frameRecords,
    (frame) => `${frame.frame_path}|${frame.url}|${frame.purpose_hint}`,
  );

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
    reveal_controls: rootData.reveal_controls,
    collapsed_sections: rootData.collapsed_sections,
    frame_tree: frameRecordsDeduped,
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
      reveal_controls: rootData.reveal_controls.length,
      collapsed_sections: rootData.collapsed_sections.length,
      frames_total: frameRecordsDeduped.length,
      frames_with_video: frameRecordsDeduped.filter((frame) => frame.video_count > 0).length,
      lazy_load_clicks: Number(lazy_load_warmup?.clicked || 0),
      lazy_load_scroll_steps: Number(lazy_load_warmup?.scroll_steps || 0),
      lazy_load_reset_to_top: Boolean(lazy_load_warmup?.reset_to_top ?? true),
    },
  };
}
