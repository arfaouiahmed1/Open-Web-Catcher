import assert from 'node:assert/strict';

import { decodeUriEverywhere, detectAccessStateFromSignals, summarizePurpose, filterElements } from '../shared/tool-runtime.js';

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

const providerMentionOnlyState = detectAccessStateFromSignals({
  title: 'FreeShot - Watch Live Stream Channels for Free',
  textSample: 'Live channels and fixtures available now.',
  htmlSample: '<script src="https://cdnjs.cloudflare.com/ajax/libs/hls.js"></script>',
  url: 'https://freeshot.live/',
});

assert.equal(providerMentionOnlyState.blocked, false);
assert.equal(providerMentionOnlyState.challenge_detected, false);
assert.equal(providerMentionOnlyState.suspected_provider, 'none');
assert.equal(providerMentionOnlyState.reasons.length, 0);

assert.equal(
  summarizePurpose('https://example.com/cdn-cgi/challenge-platform', 'challenge frame'),
  'challenge',
);

const decodedPayload = decodeUriEverywhere({
  url: 'https://example.com/%D9%83%D9%87%D8%B1%D8%A8%D8%A7%D8%A1-%D8%A7%D9%84%D8%A7%D8%B3%D9%85%D8%A7%D8%B9%D9%8A%D9%84%D9%8A%D8%A9',
  nested: {
    text: '%D9%83%D9%87%D8%B1%D8%A8%D8%A7%D8%A1',
  },
});

assert.equal(decodedPayload.url, 'https://example.com/كهرباء-الاسماعيلية');
assert.equal(decodedPayload.nested.text, 'كهرباء');

const regexMatches = filterElements(
  [
    {
      kind: 'button',
      text: 'Watch Live Now',
      href: '',
      attrs: { 'data-server': 'Server 21' },
      visible: true,
    },
    {
      kind: 'button',
      text: 'Read Blog Post',
      href: '',
      attrs: { 'data-server': 'Info' },
      visible: true,
    },
  ],
  {
    kind: 'button',
    text_regex: '(watch|live)',
    attr_name: 'data-server',
    attr_value_regex: 'server\\s*[0-9]+',
    visible_only: true,
    limit: 5,
  },
);

assert.equal(regexMatches.length, 1);
assert.equal(regexMatches[0].text, 'Watch Live Now');

console.log('Validated access-state and challenge detection helpers.');
