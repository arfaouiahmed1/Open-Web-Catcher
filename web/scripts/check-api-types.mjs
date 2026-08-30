import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const generator = fileURLToPath(new URL("./gen-api-types.mjs", import.meta.url));
const committedOutput = fileURLToPath(new URL("../src/types/api.d.ts", import.meta.url));
const tempDir = mkdtempSync(join(tmpdir(), "owc-api-types-"));
const generatedOutput = join(tempDir, "api.d.ts");

try {
  const result = spawnSync(process.execPath, [generator], {
    cwd: scriptDir,
    env: { ...process.env, OPENAPI_TYPES_OUT: generatedOutput },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);

  const normalize = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  if (normalize(generatedOutput) !== normalize(committedOutput)) {
    console.error(
      "Generated API bindings are stale. Run `npm run types:gen` and commit web/src/types/api.d.ts.",
    );
    process.exit(1);
  }
  console.log("OK: generated API bindings match committed openapi.json");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
