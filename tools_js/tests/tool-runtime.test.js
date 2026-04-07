import assert from 'node:assert/strict';

import { detectAccessStateFromSignals, summarizePurpose } from '../shared/tool-runtime.js';

const clearState = detectAccessStateFromSignals({
  title: 'Watch Live Sports',
  textSample: 'Choose a server and press play.',
  htmlSample: '<html><body><video></video></body></html>',
  url: 'https://example.com/watch/1',
});

assert.equal(clearState.blocked, false);
assert.equal(clearState.challenge_detected, false);
assert.equal(clearState.suspected_provider, 'none');

const challengeState = detectAccessStateFromSignals({
  title: 'Just a moment...',
  textSample: 'Checking your browser before accessing the site. Cloudflare',
  htmlSample: '<div id="challenge-running">cf-challenge</div>',
  url: 'https://example.com/watch/1',
});

assert.equal(challengeState.blocked, true);
assert.equal(challengeState.challenge_detected, true);
assert.equal(challengeState.suspected_provider, 'cloudflare');
assert.ok(challengeState.reasons.length > 0);

assert.equal(
  summarizePurpose('https://example.com/cdn-cgi/challenge-platform', 'challenge frame'),
  'challenge',
);

console.log('Validated access-state and challenge detection helpers.');
