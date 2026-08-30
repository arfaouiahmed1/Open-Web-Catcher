#!/usr/bin/env node
// F-wave gate (plan task 42): the operator console must be SSE-first.
//
// Fails when any component under web/components schedules work with
// `setInterval(` — data freshness must come from SSE subscriptions
// (useEventStream / useRunStream) with reconnect+backoff, never from
// time-driven polling loops. `setInterval` outside components (e.g. lib
// utilities that are not data pollers) is out of scope for this gate.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const componentsRoot = join(webRoot, "components");
const PATTERN = /setInterval\s*\(/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry)) {
      yield full;
    }
  }
}

const offenders = [];
for (const filePath of walk(componentsRoot)) {
  const text = readFileSync(filePath, "utf8");
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.includes("setInterval") || !PATTERN.test(line)) return;
    offenders.push(
      `${relative(webRoot, filePath).split(sep).join("/")}:${index + 1}: ${line.trim()}`,
    );
  });
}

if (offenders.length > 0) {
  console.error(
    [
      "check-no-polling: FAILED — setInterval polling is forbidden under web/components.",
      "Replace pollers with SSE subscriptions (@/lib/use-event-stream or @/lib/use-run-stream).",
      "",
      ...offenders.map((entry) => `  ${entry}`),
      "",
      `  ${offenders.length} offending line(s)`,
    ].join("\n"),
  );
  process.exit(1);
}

console.log("check-no-polling: OK — no setInterval polling under web/components.");
