import crypto from 'node:crypto';

/**
 * PageStateTracker tracks the DOM mutation lifecycle of a Playwright Page.
 *
 * It maintains:
 * - dom_epoch: monotonic counter incremented on meaningful DOM mutations (debounced)
 * - page_state.id: SHA-256 (16-char) of url + dom_epoch + visible candidate summary
 * - Stale-state detection: prevents interacting with nodes discovered under prior DOM epochs
 */
export class PageStateTracker {
  constructor(page) {
    this.page = page;
    this.domEpoch = 0;
    this.lastMutationTimestamp = Date.now();
    this.bindingInstalled = false;
    this._installed = false;
  }

  /**
   * Install the MutationObserver script on the page and future navigations.
   */
  async install() {
    if (this._installed) return;
    this._installed = true;

    try {
      const bindingName = `__owc_mutation_signal_${Math.random().toString(36).slice(2, 8)}`;

      // Expose function for in-page observer to notify node process
      await this.page.exposeFunction(bindingName, () => {
        this.domEpoch += 1;
        this.lastMutationTimestamp = Date.now();
      });

      // Inject observer script on document load
      const initScript = `
        (function() {
          let timer = null;
          function notify() {
            if (window.${bindingName}) {
              window.${bindingName}();
            }
          }
          function onMutation(mutations) {
            // Filter out purely invisible style or telemetry mutations
            let meaningful = false;
            for (const m of mutations) {
              if (m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
                meaningful = true;
                break;
              }
              if (m.type === 'attributes' && m.attributeName !== 'style' && m.attributeName !== 'class') {
                meaningful = true;
                break;
              }
            }
            if (!meaningful) return;
            clearTimeout(timer);
            timer = setTimeout(notify, 200);
          }
          if (window.MutationObserver) {
            const observer = new MutationObserver(onMutation);
            function start() {
              if (document.body) {
                observer.observe(document.body, { childList: true, subtree: true, attributes: true });
              } else {
                document.addEventListener('DOMContentLoaded', () => {
                  if (document.body) observer.observe(document.body, { childList: true, subtree: true, attributes: true });
                });
              }
            }
            start();
          }
        })();
      `;

      await this.page.addInitScript(initScript);

      // Also run immediately on current document if already loaded
      await this.page.evaluate(initScript).catch(() => {});
      this.bindingInstalled = true;
    } catch (err) {
      // If already installed or closed, ignore gracefully
    }
  }

  /**
   * Produce current page_state object for envelope responses.
   *
   * @param {string} [framePath='root']
   * @returns {Promise<{ id: string, dom_epoch: number, url: string, title: string, frame_path: string, captured_at: string }>}
   */
  async getPageState(framePath = 'root') {
    let url = '';
    let title = '';
    try {
      url = this.page.url() || '';
      title = await this.page.title().catch(() => '');
    } catch {
      // Page might be navigating
    }

    const stateId = this.computeStateId(url, this.domEpoch, framePath);

    return {
      id: stateId,
      dom_epoch: this.domEpoch,
      url,
      title,
      frame_path: framePath,
      captured_at: new Date().toISOString(),
    };
  }

  /**
   * Synchronous getPageState from known values (used when awaiting page methods is unsafe).
   */
  getPageStateSync(framePath = 'root', url = '', title = '') {
    const stateId = this.computeStateId(url, this.domEpoch, framePath);
    return {
      id: stateId,
      dom_epoch: this.domEpoch,
      url,
      title,
      frame_path: framePath,
      captured_at: new Date().toISOString(),
    };
  }

  /**
   * Compute a 16-character hex digest of the page state signature.
   */
  computeStateId(url, epoch, framePath = 'root') {
    return crypto
      .createHash('sha256')
      .update(`${url || ''}::${epoch}::${framePath}`)
      .digest('hex')
      .slice(0, 16);
  }

  /**
   * Check if a candidate's recorded page_state_id is stale relative to current state.
   */
  isStale(expectedStateId, framePath = 'root') {
    if (!expectedStateId) return false;
    let url = '';
    try {
      url = this.page.url() || '';
    } catch {}
    const currentStateId = this.computeStateId(url, this.domEpoch, framePath);
    return currentStateId !== expectedStateId;
  }

  /**
   * Format an element ref with encoded page_state_id: `<id>@<page_state_id>`
   */
  formatElementRef(elementId, pageStateId) {
    return `${elementId}@${pageStateId}`;
  }

  /**
   * Parse an element ref: returns `{ elementId, pageStateId }`.
   */
  parseElementRef(ref) {
    if (!ref) return { elementId: '', pageStateId: null };
    const parts = String(ref).split('@');
    if (parts.length >= 2) {
      return { elementId: parts[0], pageStateId: parts[1] };
    }
    return { elementId: parts[0], pageStateId: null };
  }
}
