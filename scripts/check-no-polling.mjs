#!/usr/bin/env node
/**
 * F-wave grep gate (plan tasks 40/42): fails when any setInterval( appears
 * under web/components or web/lib. Live data must arrive via SSE
 * (useEventStream / useRunStream) or visibility-triggered refreshes — never
 * fixed-interval polling.
 *
 * Excluded: test files (fakes may legally use timers) and this script.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
const SCAN_DIRS = [join(ROOT, "components"), join(ROOT, "lib")];
const PATTERN = /setInterval\s*\(/;
const TEST_SUFFIX = /\.(test|spec)\.[jt]sx?$/;

/** @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === "node_modules" || name === "__pycache__") continue;
      out.push(...walk(full));
    } else if (/\.(js|jsx|ts|tsx)$/.test(name) && !TEST_SUFFIX.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const offenders = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      if (PATTERN.test(line)) {
        offenders.push(`${file.replace(ROOT, "web")}:${index + 1}: ${line.trim().slice(0, 90)}`);
      }
    });
  }
}

if (offenders.length > 0) {
  console.error("FAIL: setInterval polling found (plan task 42 gate):");
  for (const hit of offenders) console.error("  " + hit);
  process.exit(1);
}
console.log("OK: no setInterval polling under web/components or web/lib");
