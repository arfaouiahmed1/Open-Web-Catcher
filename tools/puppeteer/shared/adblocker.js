// uBOL is configured at browser launch via managed Chrome policy.
// This module is intentionally a no-op so the runtime does not try to run a
// second blocker in parallel with the extension.
const enabledPages = new WeakSet();

export async function enableBlocking(page, { targetUrl = '' } = {}) {
  void targetUrl;
  if (enabledPages.has(page)) return true;
  enabledPages.add(page);
  return true;
}

export async function disableBlocking(page, { keepRequestInterception = false } = {}) {
  void keepRequestInterception;
  enabledPages.delete(page);
  return false;
}
