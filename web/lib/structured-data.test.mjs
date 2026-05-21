import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStructuredTableRows,
  filterStructuredValueForDisplay,
  normalizeStructuredValueForDisplay,
} from "./structured-data.js";

test("normalizes decoded JSON strings inside nested payloads", () => {
  const payload = {
    wrapped: "%7B%22server%22%3A%22alpha%22%2C%22state%22%3A%22playing%22%7D",
  };
  assert.deepEqual(normalizeStructuredValueForDisplay(payload), {
    wrapped: { server: "alpha", state: "playing" },
  });
});

test("filters recursively through nested arrays and objects", () => {
  const payload = {
    servers: [
      { label: "Server 1", state: "failed" },
      { label: "Server 2", state: "playing" },
    ],
  };
  assert.deepEqual(filterStructuredValueForDisplay(payload, "playing"), {
    servers: [{ label: "Server 2", state: "playing" }],
  });
});

test("limits table rows for compact cards", () => {
  const rows = buildStructuredTableRows({ a: 1, b: 2, c: 3 }, 2);
  assert.deepEqual(rows.map((row) => row.path), ["a", "b"]);
});
