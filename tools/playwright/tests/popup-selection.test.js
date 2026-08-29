import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyPopupCandidate,
  extractPopupPlayerUrls,
  isBlankPopupUrl,
  scorePopupCandidate,
  selectPopupCandidate,
} from '../../shared/popup-selection.js';

test('same-origin player popup wins over an advertising popup', () => {
  const candidates = [
    { url: 'https://ads.example.net/popunder?id=12' },
    { url: 'https://livetv.sx/webplayer.php?stream=42' },
  ];

  assert.equal(
    selectPopupCandidate(candidates, 'https://livetv.sx/enx/eventinfo/42/'),
    candidates[1],
  );
});

test('cross-origin player signals can beat an unrelated popup', () => {
  const candidates = [
    { url: 'https://random.example.org/offer' },
    { url: 'https://cdn.example.net/embed/player/42' },
  ];

  assert.equal(
    selectPopupCandidate(candidates, 'https://sports.example.com/event/42'),
    candidates[1],
  );
});

test('blank popup targets are ignored until they navigate', () => {
  assert.equal(isBlankPopupUrl('about:blank'), true);
  assert.equal(
    scorePopupCandidate({ url: 'about:blank' }, 'https://example.com'),
    Number.NEGATIVE_INFINITY,
  );
});

test('an advertising-only popup is rejected', () => {
  assert.equal(
    selectPopupCandidate(
      [{ url: 'https://ads.example.net/popunder?id=12' }],
      'https://sports.example.com/event/42',
    ),
    null,
  );
});

test('same-host ad or promo target is not adopted from hostname alone', () => {
  const candidate = { url: 'https://sports.example.com/promo/download?ad=1' };
  const classification = classifyPopupCandidate(candidate, 'https://sports.example.com/watch/game-1');

  assert.equal(classification.same_origin, true);
  assert.equal(classification.adoptable, false);
  assert.equal(classification.classification, 'ad_or_drift');
  assert.equal(selectPopupCandidate([candidate], 'https://sports.example.com/watch/game-1'), null);
});

test('same-content player can be adopted across hostnames', () => {
  const candidate = {
    initial_url: 'about:blank',
    final_url: 'https://cdn-player.example.net/embed/player/game-1',
    title: 'Player',
  };
  const classification = classifyPopupCandidate(candidate, 'https://sports.example.com/watch/game-1');

  assert.equal(classification.same_origin, false);
  assert.equal(classification.adoptable, true);
  assert.equal(classification.target_decision, 'adopt_same_content_player');
  assert.equal(selectPopupCandidate([candidate], 'https://sports.example.com/watch/game-1'), candidate);
});

test('off-domain popup with encoded player urls is adopted as same-content evidence', () => {
  const encoded = [
    Buffer.from('سيرفر 1 =').toString('base64'),
    Buffer.from(' https://ex.roooom.online/?alba-player=ysscores\nسيرفر 2 =').toString('base64'),
    Buffer.from(' https://player.syria-player.live/albaplayer/beinmax1/\nسيرفر 3 => https://s30.yalla-sport.top/ch/ch1.php').toString('base64'),
  ].join('__');
  const candidate = {
    url: `https://elsaudia.net/read925/55.php?hash=${encoded}`,
    title: 'Get Business Loan',
  };
  const classification = classifyPopupCandidate(
    candidate,
    'https://www.yallashoot.video/video/bein-sports-max-1-live-stream-28-6-2026/',
  );

  assert.equal(classification.same_origin, false);
  assert.equal(classification.adoptable, true);
  assert.equal(classification.classification, 'encoded_player_redirect');
  assert.equal(classification.target_decision, 'adopt_same_content_player');
  assert.deepEqual(extractPopupPlayerUrls(candidate), [
    'https://ex.roooom.online/?alba-player=ysscores',
    'https://player.syria-player.live/albaplayer/beinmax1/',
    'https://s30.yalla-sport.top/ch/ch1.php',
  ]);
  assert.equal(selectPopupCandidate([candidate], 'https://www.yallashoot.video/video/watch'), candidate);
});

test('multiple tabs adopt only the best player target', () => {
  const candidates = [
    { url: 'https://sports.example.com/promo' },
    { url: 'https://ads.example.net/popunder?id=12' },
    { url: 'https://cdn.example.net/embed/player/42' },
  ];

  assert.equal(
    selectPopupCandidate(candidates, 'https://sports.example.com/event/42'),
    candidates[2],
  );
});

test('blocked window.open attempts can be represented as non-adoptable evidence', () => {
  const blocked = {
    blocked: true,
    url: 'https://ads.example.net/popunder?id=12',
    reason: 'window_open_blocked',
  };
  const classification = classifyPopupCandidate(blocked, 'https://sports.example.com/watch/game-1');

  assert.equal(classification.adoptable, false);
  assert.equal(classification.target_decision, 'close_unadopted');
});
