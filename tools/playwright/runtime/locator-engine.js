import { TOOL_ERROR_CODES } from '../../shared/error-codes.js';

export class LocatorError extends Error {
  constructor(code, message, attempts = []) {
    super(message);
    this.name = 'LocatorError';
    this.code = code;
    this.attempts = attempts;
  }
}

/**
 * LocatorEngine resolves element targets across frames using a prioritized chain:
 * 1. candidate_id (validated against pageStateTracker to detect DOM mutations)
 * 2. ARIA role + name
 * 3. Scoped CSS
 * 4. XPath
 * 5. Visible text
 * 6. Explicit coordinates (only when allow_coordinate_fallback is true)
 */
export class LocatorEngine {
  constructor(page, pageStateTracker = null) {
    this.page = page;
    this.pageStateTracker = pageStateTracker;
  }

  /**
   * Resolve an element target using input criteria.
   *
   * @param {object} opts
   * @param {string} [opts.candidate_id]
   * @param {string} [opts.frame_path='root']
   * @param {string} [opts.role]
   * @param {string} [opts.name]
   * @param {string} [opts.css]
   * @param {string} [opts.xpath]
   * @param {string} [opts.text]
   * @param {number} [opts.x]
   * @param {number} [opts.y]
   * @param {boolean} [opts.allow_coordinate_fallback=false]
   * @returns {Promise<{ locator: import('playwright').Locator|null, coordinates: { x: number, y: number }|null, strategyUsed: string, attempts: Array<{ strategy: string, query: string, matched: number, error?: string }> }>}
   */
  async resolve(opts = {}) {
    const attempts = [];
    const frame = this._resolveFrame(opts.frame_path || 'root');

    // 1. Candidate ID ref (e.g. "c_12" or "c_12@stateId")
    if (opts.candidate_id) {
      const parsed = this._parseCandidateId(opts.candidate_id);
      if (parsed.pageStateId && this.pageStateTracker) {
        if (this.pageStateTracker.isStale(parsed.pageStateId, opts.frame_path || 'root')) {
          attempts.push({
            strategy: 'candidate_id',
            query: opts.candidate_id,
            matched: 0,
            error: 'DOM epoch mutated since candidate was observed',
          });
          throw new LocatorError(
            TOOL_ERROR_CODES.ERR_STALE_PAGE_STATE,
            `Candidate "${opts.candidate_id}" was observed in a prior DOM epoch. Please re-inspect the page.`,
            attempts,
          );
        }
      }

      // Try resolving by data-owc-candidate attribute or aria label
      const candidateLocators = [
        frame.locator(`[data-owc-id="${parsed.id}"]`),
        frame.locator(`[id="${parsed.id}"]`),
      ];

      for (const loc of candidateLocators) {
        const count = await loc.count().catch(() => 0);
        attempts.push({ strategy: 'candidate_id', query: parsed.id, matched: count });
        if (count === 1) {
          return { locator: loc.first(), coordinates: null, strategyUsed: 'candidate_id', attempts };
        }
        if (count > 1) {
          throw new LocatorError(
            TOOL_ERROR_CODES.ERR_AMBIGUOUS_TARGET,
            `Candidate id "${opts.candidate_id}" matched ${count} elements.`,
            attempts,
          );
        }
      }
    }

    // 2. ARIA role + accessible name
    if (opts.role) {
      const roleOpts = opts.name ? { name: opts.name } : {};
      const loc = frame.getByRole(opts.role, roleOpts);
      const count = await loc.count().catch(() => 0);
      attempts.push({ strategy: 'aria_role_name', query: `${opts.role}[name=${opts.name || '*'}]`, matched: count });
      if (count === 1) {
        return { locator: loc.first(), coordinates: null, strategyUsed: 'aria_role_name', attempts };
      }
      if (count > 1) {
        throw new LocatorError(
          TOOL_ERROR_CODES.ERR_AMBIGUOUS_TARGET,
          `Role "${opts.role}" with name "${opts.name}" matched ${count} elements.`,
          attempts,
        );
      }
    }

    // 3. Scoped CSS
    if (opts.css) {
      const loc = frame.locator(opts.css);
      const count = await loc.count().catch(() => 0);
      attempts.push({ strategy: 'css', query: opts.css, matched: count });
      if (count === 1) {
        return { locator: loc.first(), coordinates: null, strategyUsed: 'css', attempts };
      }
      if (count > 1) {
        throw new LocatorError(
          TOOL_ERROR_CODES.ERR_AMBIGUOUS_TARGET,
          `CSS selector "${opts.css}" matched ${count} elements. Specify a more restrictive selector.`,
          attempts,
        );
      }
    }

    // 4. XPath
    if (opts.xpath) {
      const loc = frame.locator(`xpath=${opts.xpath}`);
      const count = await loc.count().catch(() => 0);
      attempts.push({ strategy: 'xpath', query: opts.xpath, matched: count });
      if (count === 1) {
        return { locator: loc.first(), coordinates: null, strategyUsed: 'xpath', attempts };
      }
      if (count > 1) {
        throw new LocatorError(
          TOOL_ERROR_CODES.ERR_AMBIGUOUS_TARGET,
          `XPath "${opts.xpath}" matched ${count} elements.`,
          attempts,
        );
      }
    }

    // 5. Visible text
    if (opts.text) {
      const loc = frame.getByText(opts.text, { exact: false });
      const count = await loc.count().catch(() => 0);
      attempts.push({ strategy: 'text', query: opts.text, matched: count });
      if (count === 1) {
        return { locator: loc.first(), coordinates: null, strategyUsed: 'text', attempts };
      }
      if (count > 1) {
        throw new LocatorError(
          TOOL_ERROR_CODES.ERR_AMBIGUOUS_TARGET,
          `Visible text "${opts.text}" matched ${count} elements.`,
          attempts,
        );
      }
    }

    // 6. Coordinates (only when allow_coordinate_fallback is explicitly true)
    if (opts.allow_coordinate_fallback && typeof opts.x === 'number' && typeof opts.y === 'number') {
      attempts.push({ strategy: 'coordinates', query: `(${opts.x}, ${opts.y})`, matched: 1 });
      return {
        locator: null,
        coordinates: { x: opts.x, y: opts.y },
        strategyUsed: 'coordinates',
        attempts,
      };
    }

    // If nothing matched
    throw new LocatorError(
      TOOL_ERROR_CODES.ERR_ELEMENT_NOT_FOUND,
      'No element matched any locator strategy in the resolution chain.',
      attempts,
    );
  }

  _resolveFrame(framePath = 'root') {
    if (!framePath || framePath === 'root') {
      return this.page;
    }
    // Search frame by name or URL
    const frames = this.page.frames();
    const match = frames.find((f) => f.name() === framePath || f.url().includes(framePath));
    if (match) return match;
    return this.page;
  }

  _parseCandidateId(candidateId) {
    const parts = String(candidateId || '').split('@');
    return {
      id: parts[0],
      pageStateId: parts[1] || null,
    };
  }
}
