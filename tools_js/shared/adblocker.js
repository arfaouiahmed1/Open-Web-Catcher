/**
 * shared/adblocker.js - cosmetic filtering driven by uBO-style filterlists.
 *
 * This intentionally does NOT block network requests. It only parses cosmetic
 * element-hiding rules such as:
 *   ##.cookie-banner
 *   example.com##.annoyance
 *   example.com#@#.keep-this-visible
 *
 * The goal is compatibility with the common cosmetic subset used by uBlock
 * Origin / ABP-style lists while staying simple and easy to extend locally.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILTERLIST_DIR = path.join(__dirname, 'filterlists');
const STYLE_ID = 'owc-global-cosmetic-filters';
const FLAG = '__owcCosmeticFilteringEnabled';
const STATE_KEY = '__owcCosmeticFilteringState';
const UNSUPPORTED_SELECTOR_PATTERN =
  /(^\+js\()|(:has-text\()|(:matches-css\()|(:matches-media\()|(:matches-path\()|(:min-text-length\()|(:nth-ancestor\()|(:others\()|(:upward\()|(:watch-attr\()|(:xpath\()|(:remove\()|(:style\()|(:-abp-)/i;
const RULE_MARKERS = ['#@?#', '#@#', '#?#', '##'];
const instrumentedPages = new WeakSet();

let _rules = null;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDomainPattern(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\|\|/, '')
    .replace(/\^$/, '')
    .replace(/^\*\./, '');
}

function findRuleMarker(line) {
  const matches = RULE_MARKERS
    .map((marker) => ({ marker, index: line.indexOf(marker) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index || b.marker.length - a.marker.length);

  return matches[0] ?? null;
}

function parseDomainSpec(value) {
  const includeDomains = [];
  const excludeDomains = [];

  if (!value) {
    return { includeDomains, excludeDomains };
  }

  for (const token of value.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('~')) {
      excludeDomains.push(normalizeDomainPattern(trimmed.slice(1)));
    } else {
      includeDomains.push(normalizeDomainPattern(trimmed));
    }
  }

  return { includeDomains, excludeDomains };
}

function parseCosmeticRule(line, sourceFile, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('!') || trimmed.startsWith('[')) return null;
  if (trimmed.startsWith('@@') && !trimmed.includes('#@#') && !trimmed.includes('#@?#')) return null;
  if (trimmed.includes('#$#') || trimmed.includes('#@$#')) return null;

  const match = findRuleMarker(trimmed);
  if (!match) return null;

  const domainPart = trimmed.slice(0, match.index).trim();
  const selector = trimmed.slice(match.index + match.marker.length).trim();
  if (!selector || UNSUPPORTED_SELECTOR_PATTERN.test(selector)) {
    return null;
  }

  const { includeDomains, excludeDomains } = parseDomainSpec(domainPart);

  return {
    selector,
    includeDomains,
    excludeDomains,
    exception: match.marker.includes('@'),
    source: `${sourceFile}:${lineNumber}`,
  };
}

async function loadFilterRules() {
  if (_rules) {
    return _rules;
  }

  const entries = await fs.readdir(FILTERLIST_DIR, { withFileTypes: true });
  const filterFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.txt'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const rules = [];

  for (const fileName of filterFiles) {
    const fullPath = path.join(FILTERLIST_DIR, fileName);
    const raw = await fs.readFile(fullPath, 'utf8');
    const lines = raw.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      const rule = parseCosmeticRule(line, fileName, index + 1);
      if (rule) {
        rules.push(rule);
      }
    }
  }

  _rules = rules;
  return rules;
}

function hostnameMatchesPattern(hostname, pattern) {
  if (!pattern || pattern === '*') {
    return true;
  }

  if (pattern.includes('*')) {
    const wildcardRegex = new RegExp(`(^|\\.)${pattern.split('*').map(escapeRegex).join('.*')}$`, 'i');
    return wildcardRegex.test(hostname);
  }

  return hostname === pattern || hostname.endsWith(`.${pattern}`);
}

function ruleAppliesToHostname(rule, hostname) {
  const included = rule.includeDomains.length === 0
    || rule.includeDomains.some((pattern) => hostnameMatchesPattern(hostname, pattern));
  if (!included) {
    return false;
  }

  return !rule.excludeDomains.some((pattern) => hostnameMatchesPattern(hostname, pattern));
}

function resolveSelectorsForUrl(rules, pageUrl = '') {
  let hostname = '';

  if (pageUrl) {
    try {
      hostname = new URL(pageUrl).hostname.toLowerCase();
    } catch (_) {
      hostname = '';
    }
  }

  const selectors = [];
  const exceptionSelectors = new Set();

  for (const rule of rules) {
    if (!ruleAppliesToHostname(rule, hostname)) {
      continue;
    }

    if (rule.exception) {
      exceptionSelectors.add(rule.selector);
      continue;
    }

    selectors.push(rule.selector);
  }

  return selectors.filter((selector) => !exceptionSelectors.has(selector));
}

function buildRuntimeInstaller() {
  return ({ flag, stateKey, styleId, rules }) => {
    const unsupportedSelectorPattern =
      /(^\+js\()|(:has-text\()|(:matches-css\()|(:matches-media\()|(:matches-path\()|(:min-text-length\()|(:nth-ancestor\()|(:others\()|(:upward\()|(:watch-attr\()|(:xpath\()|(:remove\()|(:style\()|(:-abp-)/i;

    const hostnameMatchesPattern = (hostname, pattern) => {
      if (!pattern || pattern === '*') {
        return true;
      }

      if (pattern.includes('*')) {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
        return new RegExp(`(^|\\.)${escaped}$`, 'i').test(hostname);
      }

      return hostname === pattern || hostname.endsWith(`.${pattern}`);
    };

    const ruleAppliesToLocation = (rule) => {
      const hostname = (location.hostname || '').toLowerCase();
      const included = rule.includeDomains.length === 0
        || rule.includeDomains.some((pattern) => hostnameMatchesPattern(hostname, pattern));
      if (!included) {
        return false;
      }

      return !rule.excludeDomains.some((pattern) => hostnameMatchesPattern(hostname, pattern));
    };

    const isSupportedSelector = (selector) => {
      if (!selector || unsupportedSelectorPattern.test(selector)) {
        return false;
      }

      try {
        document.querySelector(selector);
        return true;
      } catch (_) {
        return false;
      }
    };

    const resolveActiveSelectors = () => {
      const active = [];
      const exceptions = new Set();

      for (const rule of rules) {
        if (!ruleAppliesToLocation(rule)) {
          continue;
        }

        if (!isSupportedSelector(rule.selector)) {
          continue;
        }

        if (rule.exception) {
          exceptions.add(rule.selector);
          continue;
        }

        active.push(rule.selector);
      }

      return [...new Set(active.filter((selector) => !exceptions.has(selector)))];
    };

    const buildCss = (selectors) => {
      const hideCss = selectors.length
        ? `${selectors.join(',\n')} {\n  display: none !important;\n  visibility: hidden !important;\n  opacity: 0 !important;\n  pointer-events: none !important;\n}`
        : '';

      const unlockCss = `html body[data-owc-scroll-unlock="1"] {\n  overflow: auto !important;\n  position: static !important;\n}`;

      return [hideCss, unlockCss].filter(Boolean).join('\n\n');
    };

    const applyInlineCleanup = (selectors) => {
      if (!document.documentElement) {
        return;
      }

      for (const selector of selectors) {
        try {
          for (const element of document.querySelectorAll(selector)) {
            element.style.setProperty('display', 'none', 'important');
            element.style.setProperty('visibility', 'hidden', 'important');
            element.style.setProperty('opacity', '0', 'important');
            element.style.setProperty('pointer-events', 'none', 'important');
          }
        } catch (_) {
          // Ignore unsupported selectors at runtime.
        }
      }

      document.documentElement.setAttribute('data-owc-scroll-unlock', '1');
      document.body?.setAttribute('data-owc-scroll-unlock', '1');
      document.documentElement.style.setProperty('overflow', 'auto', 'important');
      document.body?.style.setProperty('overflow', 'auto', 'important');
    };

    const install = () => {
      if (!document.documentElement) {
        return false;
      }

      const selectors = resolveActiveSelectors();
      let style = document.getElementById(styleId);
      if (!style) {
        const parent = document.head || document.documentElement;
        if (!parent) {
          return false;
        }

        style = document.createElement('style');
        style.id = styleId;
        parent.appendChild(style);
      }

      style.textContent = buildCss(selectors);
      applyInlineCleanup(selectors);
      return true;
    };

    const ensureInstalled = () => {
      const installed = install();
      if (!installed || !document.documentElement) {
        return;
      }

      if (!window[stateKey].observer) {
        window[stateKey].observer = new MutationObserver(() => install());
        window[stateKey].observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    };

    if (!window[stateKey]) {
      window[stateKey] = { observer: null };
    }

    window[flag] = true;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ensureInstalled, { once: true });
    }

    ensureInstalled();
  };
}

export async function getCosmeticFilterRules() {
  return loadFilterRules();
}

export async function getCosmeticFilterSelectors(pageUrl = '') {
  const rules = await loadFilterRules();
  return resolveSelectorsForUrl(rules, pageUrl);
}

export async function enableBlocking(page) {
  const rules = await loadFilterRules();
  const installFilters = buildRuntimeInstaller();

  if (!instrumentedPages.has(page)) {
    await page.evaluateOnNewDocument(installFilters, {
      flag: FLAG,
      stateKey: STATE_KEY,
      styleId: STYLE_ID,
      rules,
    });
    instrumentedPages.add(page);
  }

  await page.evaluate(installFilters, {
    flag: FLAG,
    stateKey: STATE_KEY,
    styleId: STYLE_ID,
    rules,
  });
}
