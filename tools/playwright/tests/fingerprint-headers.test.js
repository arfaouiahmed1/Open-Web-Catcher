import test from 'node:test';
import assert from 'node:assert/strict';

import { selectPersistentFingerprintHeaders } from '../../shared/fingerprint-headers.js';

test('fingerprint headers exclude navigation-only request metadata', () => {
  const headers = selectPersistentFingerprintHeaders({
    accept: 'text/html,*/*',
    'accept-encoding': 'gzip, br',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'max-age=0',
    'sec-ch-ua': '"Chromium";v="149"',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-site',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent': 'Chrome/149',
  });

  assert.deepEqual(headers, {
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="149"',
    'sec-ch-ua-platform': '"Windows"',
    'user-agent': 'Chrome/149',
  });
});

test('fingerprint header filtering preserves input casing and does not mutate input', () => {
  const input = {
    'User-Agent': 'Chrome/149',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-Fetch-Mode': 'navigate',
  };

  const headers = selectPersistentFingerprintHeaders(input);

  assert.deepEqual(headers, {
    'User-Agent': 'Chrome/149',
    'Sec-CH-UA-Mobile': '?0',
  });
  assert.equal(input['Sec-Fetch-Mode'], 'navigate');
});
