import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("inspect_hosting exposes iframe videos as activation targets", () => {
  const text = fs.readFileSync(path.resolve("tools/inspect_hosting.js"), "utf8");

  assert.match(text, /sample_videos/);
  assert.match(text, /function frameVideoTargets/);
  assert.match(text, /\.\.\.frameVideoTargets\(data\)/);
  assert.match(text, /frame_path: frame\.frame_path \|\| 'root'/);
});

test("inspect_embedded keeps iframe video exposure aligned with hosting", () => {
  const text = fs.readFileSync(path.resolve("tools/inspect_embedded.js"), "utf8");

  assert.match(text, /sample_videos/);
  assert.match(text, /function frameVideoTargets/);
  assert.match(text, /\.\.\.frameVideoTargets\(data\)/);
});
