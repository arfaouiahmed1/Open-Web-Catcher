import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasSpecificQuery,
  matchesScopeXpath,
  querySpecificity,
} from '../tools/context-tools.js';

test('query_elements treats bare kind and limit as underspecified', () => {
  const query = { kind: 'link', limit: 10 };

  assert.equal(hasSpecificQuery(query), false);
  assert.equal(querySpecificity(query), 0);
});

test('query_elements specificity includes predicates and scopes', () => {
  assert.equal(hasSpecificQuery({ kind: 'link', href_regex: '/watch/' }), true);
  assert.equal(hasSpecificQuery({ kind: 'button', scope_selector: '.player' }), true);
  assert.equal(hasSpecificQuery({ kind: 'link', scope_node_id: 'node-12' }), true);
  assert.equal(querySpecificity({ text_regex: '(watch|play)', scope_xpath: '//main[1]' }), 3);
});

test('query_elements xpath scope matches descendants only', () => {
  assert.equal(matchesScopeXpath({ xpath: '//html[1]/body[1]/main[1]/a[1]' }, '//html[1]/body[1]/main[1]'), true);
  assert.equal(matchesScopeXpath({ xpath: '//html[1]/body[1]/footer[1]/a[1]' }, '//html[1]/body[1]/main[1]'), false);
});
