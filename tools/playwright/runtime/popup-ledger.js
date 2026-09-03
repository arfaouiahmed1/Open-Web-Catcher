/**
 * PopupLedger tracks secondary pages (popups, target="_blank" tabs) opened in a context.
 *
 * It prevents popups from leaking across tool calls and enables inspecting or closing them.
 */

import {
  classifyPopupCandidate,
  isBlankPopupUrl,
  selectPopupCandidate,
} from "../../shared/popup-selection.js";

export function makeObservedChange(before, after, newTabUrls = [], popupTelemetry = {}) {
  return {
    navigated: before.url !== after.url,
    url_changed: before.url !== after.url,
    dom_changed: before.dom_epoch !== after.dom_epoch,
    popup_opened: newTabUrls.length > 0,
    new_tab_urls: newTabUrls,
    opened_targets: popupTelemetry.opened_targets || [],
    blocked_popup_attempts: popupTelemetry.blocked_popup_attempts || [],
    selected_target: popupTelemetry.selected_target || null,
    target_decision:
      popupTelemetry.target_decision ||
      (newTabUrls.length ? "no_adoptable_popup" : "no_popup"),
    active_page_url: popupTelemetry.active_page_url || after.url,
    opener_url: popupTelemetry.opener_url || before.url,
  };
}
function popupTargetTelemetry(candidate, openerUrl, selected = null, closeUnadopted = true) {
  const classification = classifyPopupCandidate(candidate, openerUrl);
  const isSelected = Boolean(selected && candidate === selected);
  const action = isSelected
    ? "adopted"
    : closeUnadopted
      ? "closed"
      : "ignored";
  const finalDecision = isSelected || closeUnadopted
    ? classification.target_decision
    : "left_open_unadopted";
  return {
    index: Number(candidate?.index || 0),
    initial_url: candidate?.initial_url || candidate?.initialUrl || "",
    final_url: candidate?.url || candidate?.final_url || candidate?.finalUrl || "",
    url: candidate?.url || candidate?.final_url || candidate?.finalUrl || "",
    title: candidate?.title || "",
    opener_url: openerUrl,
    classification: classification.classification,
    same_origin: Boolean(classification.same_origin),
    adoptable: Boolean(classification.adoptable),
    selected: isSelected,
    adopted: isSelected,
    action,
    target_decision: finalDecision,
    decision_reason: classification.reason,
    extracted_player_urls: classification.extracted_player_urls || [],
    closed: !isSelected && closeUnadopted,
  };
}

async function readBlockedPopupAttempts(page, startedAt = 0) {
  if (!page || page.isClosed()) return [];
  try {
    return (
      (await page.evaluate((since) => {
        const attempts = window.__owc_blocked_window_open_attempts || [];
        return attempts
          .filter((a) => !since || a.timestamp >= since)
          .map((row, index) => ({
            index,
            url: String(row?.url || ""),
            target: String(row?.target || ""),
            features: String(row?.features || ""),
            timestamp: Number(row?.timestamp || 0),
            blocked: true,
            reason: String(row?.reason || "window_open_blocked"),
          }));
      }, startedAt)) || []
    );
  } catch {
    return [];
  }
}

function blockedPopupTelemetry(attempt, openerUrl, index = 0) {
  const classification = classifyPopupCandidate(attempt, openerUrl);
  return {
    index,
    url: String(attempt?.url || ""),
    target: String(attempt?.target || ""),
    features: String(attempt?.features || ""),
    timestamp: Number(attempt?.timestamp || 0),
    blocked: true,
    reason: String(attempt?.reason || "window_open_blocked"),
    opener_url: openerUrl,
    classification: classification.classification,
    same_origin: Boolean(classification.same_origin),
    adoptable: false,
    action: "blocked",
    target_decision: classification.target_decision,
    decision_reason: classification.reason,
    extracted_player_urls: classification.extracted_player_urls || [],
  };
}

export function trackNewTabs(
  context,
  { openerPage = null, adopt = true, closeUnadopted = true } = {},
) {
  const newTabUrls = [];
  const candidates = [];
  const pending = new Set();
  const openerUrl = openerPage?.url?.() || "";
  const startedAt = Date.now();

  const tracker = {
    new_tab_urls: newTabUrls,
    opened_targets: [],
    blocked_popup_attempts: [],
    selected_target: null,
    target_decision: "no_popup",
    active_page_url: openerUrl,
    opener_url: openerUrl,
    async settle({ timeoutMs = 3000 } = {}) {
      const tasks = [...pending];
      if (tasks.length > 0) {
        await Promise.race([
          Promise.allSettled(tasks),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }

      for (const candidate of candidates) {
        if (!candidate.page?.isClosed?.()) {
          candidate.url = candidate.page.url();
          candidate.final_url = candidate.url;
          candidate.title = await candidate.page.title().catch(() => "");
          newTabUrls[candidate.index] = candidate.url;
        }
      }

      const selected = adopt
        ? selectPopupCandidate(candidates, openerUrl)
        : null;

      tracker.opened_targets.splice(
        0,
        tracker.opened_targets.length,
        ...candidates.map((candidate) =>
          popupTargetTelemetry(candidate, openerUrl, selected, closeUnadopted)),
      );

      const blockedAttempts = await readBlockedPopupAttempts(openerPage, startedAt);
      tracker.blocked_popup_attempts.splice(
        0,
        tracker.blocked_popup_attempts.length,
        ...blockedAttempts.map((attempt, index) =>
          blockedPopupTelemetry(attempt, openerUrl, index)),
      );

      if (closeUnadopted) {
        await Promise.allSettled(
          candidates
            .filter((candidate) => candidate !== selected)
            .map((candidate) => candidate.page?.close?.()),
        );
      }

      const resultPage = selected?.page && !selected.page.isClosed()
        ? selected.page
        : openerPage;
      tracker.selected_target = selected
        ? popupTargetTelemetry(selected, openerUrl, selected, closeUnadopted)
        : null;
      tracker.target_decision = tracker.selected_target
        ? tracker.selected_target.target_decision
        : tracker.blocked_popup_attempts.length
          ? "blocked_popup_attempts_only"
          : tracker.opened_targets.length
            ? "no_adoptable_popup"
            : "no_popup";
      tracker.active_page_url = resultPage?.url?.() || openerUrl;
      return resultPage || openerPage;
    },
    dispose: () => context.off("page", listener),
  };

  const recordPage = async (page) => {
    try {
      if (!page || page === openerPage) return;

      const initialUrl = page.url();
      const candidate = {
        index: candidates.length,
        page,
        initial_url: initialUrl,
        final_url: initialUrl,
        url: initialUrl,
        title: "",
        opener_url: openerUrl,
      };
      candidates.push(candidate);
      newTabUrls.push(candidate.url);

      if (isBlankPopupUrl(candidate.url)) {
        await page
          .waitForLoadState("domcontentloaded", { timeout: 2500 })
          .catch(() => {});
      }

      candidate.url = page.url();
      candidate.final_url = candidate.url;
      candidate.title = await page.title().catch(() => "");
      candidate.classification = classifyPopupCandidate(candidate, openerUrl);
      newTabUrls[candidate.index] = candidate.url;
    } catch {
      // Best-effort
    }
  };

  const listener = (page) => {
    const task = recordPage(page).finally(() => pending.delete(task));
    pending.add(task);
  };

  context.on("page", listener);
  return tracker;
}

export class PopupLedger {
  constructor(context, mainPage = null) {
    this.context = context;
    this.mainPage = mainPage;
    this.popups = [];
    this._handler = null;
  }

  start(mainPage = null) {
    if (mainPage) this.mainPage = mainPage;
    if (this._handler || !this.context) return;

    this._handler = (newPage) => {
      if (newPage === this.mainPage) return;

      const record = {
        page: newPage,
        url: newPage.url() || '',
        openedAt: Date.now(),
        closed: false,
      };
      this.popups.push(record);

      newPage.on('close', () => {
        record.closed = true;
      });
      newPage.on('framenavigated', (frame) => {
        if (frame === newPage.mainFrame()) {
          record.url = frame.url();
        }
      });
    };

    this.context.on('page', this._handler);
  }

  stop() {
    if (this._handler && this.context) {
      try {
        this.context.off('page', this._handler);
      } catch {}
      this._handler = null;
    }
  }

  getActivePopups() {
    return this.popups.filter((p) => !p.closed && !p.page.isClosed());
  }

  async closeAll() {
    const active = this.getActivePopups();
    await Promise.all(
      active.map(async (p) => {
        try {
          await p.page.close();
        } catch {}
        p.closed = true;
      }),
    );
  }

  findPopup(pattern) {
    const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
    return this.getActivePopups().find((p) => regex.test(p.url));
  }
}
