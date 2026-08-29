const PERSISTENT_FINGERPRINT_HEADERS = new Set([
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-mobile',
  'sec-ch-ua-model',
  'sec-ch-ua-platform',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-wow64',
  'user-agent',
]);

export function selectPersistentFingerprintHeaders(headers = {}) {
  const selected = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    if (!PERSISTENT_FINGERPRINT_HEADERS.has(String(name).toLowerCase())) continue;
    selected[String(name)] = String(value);
  }
  return selected;
}
