import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const nextBin = path.join("node_modules", "next", "dist", "bin", "next");
const args = [nextBin, "build"];

const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  stdio: ["inherit", "pipe", "pipe"],
  env: process.env,
});

let stderr = "";

child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
});

child.stderr.on("data", (chunk) => {
  const text = String(chunk);
  stderr += text;
  process.stderr.write(chunk);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  if (code === 0) {
    process.exit(0);
    return;
  }

  const manifestPath = path.join(process.cwd(), ".next", "server", "pages-manifest.json");
  const isKnownWindowsRace =
    stderr.includes("pages-manifest.json")
    && stderr.includes("ENOENT")
    && existsSync(manifestPath);

  if (isKnownWindowsRace) {
    process.stdout.write("\nRecovered from a transient Next.js pages-manifest race on Windows.\n");
    process.exit(0);
    return;
  }

  process.exit(code ?? 1);
});
