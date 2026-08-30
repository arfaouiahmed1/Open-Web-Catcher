import test from "node:test";
import assert from "node:assert/strict";

import {
  formatDate,
  formatTime,
  formatTimestamp,
  parseTimestamp,
} from "./datetime.js";

test("parseTimestamp parses Z-suffixed ISO stamps as the correct instant", () => {
  const d = parseTimestamp("2026-08-26T12:00:00Z");
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), Date.UTC(2026, 7, 26, 12, 0, 0));
});

test("parseTimestamp parses offset stamps", () => {
  assert.equal(
    parseTimestamp("2026-08-26T12:00:00+00:00").getTime(),
    Date.UTC(2026, 7, 26, 12, 0, 0)
  );
  assert.equal(
    parseTimestamp("2026-08-26T14:00:00+02:00").getTime(),
    Date.UTC(2026, 7, 26, 12, 0, 0)
  );
});

test("parseTimestamp treats NAIVE stamps as UTC, not browser-local time", () => {
  // Legacy payload without a designator must not shift with browser TZ.
  assert.equal(
    parseTimestamp("2026-08-26 12:00:00").getTime(),
    Date.UTC(2026, 7, 26, 12, 0, 0)
  );
  assert.equal(
    parseTimestamp("2026-08-26T12:00:00.123456").getTime(),
    Date.UTC(2026, 7, 26, 12, 0, 0, 123)
  );
});

test("parseTimestamp handles epoch numbers (seconds and ms) and numeric strings", () => {
  const ms = Date.UTC(2026, 7, 26, 12, 0, 0);
  assert.equal(parseTimestamp(ms / 1000).getTime(), ms);
  assert.equal(parseTimestamp(ms).getTime(), ms);
  assert.equal(parseTimestamp(String(ms)).getTime(), ms);
});

test("parseTimestamp returns null for junk/empty input", () => {
  assert.equal(parseTimestamp(null), null);
  assert.equal(parseTimestamp(undefined), null);
  assert.equal(parseTimestamp(""), null);
  assert.equal(parseTimestamp("not-a-date"), null);
  assert.equal(parseTimestamp({}), null);
});

test("formatTimestamp renders the same string as toLocaleString on the parsed instant", () => {
  const stamp = "2026-08-26T12:00:00Z";
  assert.equal(formatTimestamp(stamp), parseTimestamp(stamp).toLocaleString());
});

test("formatters degrade to empty string on bad input", () => {
  assert.equal(formatTimestamp(null), "");
  assert.equal(formatTime("junk"), "");
  assert.equal(formatDate(undefined), "");
});
