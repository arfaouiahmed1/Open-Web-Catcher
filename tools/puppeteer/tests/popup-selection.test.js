import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
