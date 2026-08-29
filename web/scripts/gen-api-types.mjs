import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Generates typed API bindings for the operator console from the backend's
// OpenAPI schema. Scaffolding-only until the backend OpenAPI contract is fully
// typed (plan task 13); the generated file lands at src/types/api.d.ts and is
// consumed by the component library wave (plan task 37+).
//
// Configuration:
//   OPENAPI_SCHEMA_PATH - explicit schema path (defaults to committed root
//                         openapi.json; no live localhost dependency)
//   OPENAPI_TYPES_OUT   - output path (default: web/src/types/api.d.ts)

const schemaPath =
  process.env.OPENAPI_SCHEMA_PATH ||
  fileURLToPath(new URL("../../openapi.json", import.meta.url));
const outFile =
  process.env.OPENAPI_TYPES_OUT ||
  fileURLToPath(new URL("../src/types/api.d.ts", import.meta.url));
const require = createRequire(import.meta.url);
// Resolve the package root first. Its export map aliases `*.js` to `*.mjs`,
// while the published executable remains bin/cli.js on disk.
const openapiTypescriptCli = join(
  dirname(require.resolve("openapi-typescript/package.json")),
  "bin",
  "cli.js",
);

console.log(`[types:gen] Generating API types from ${schemaPath}`);
console.log(`[types:gen] Output: ${outFile}`);

const result = spawnSync(
  process.execPath,
  [openapiTypescriptCli, schemaPath, "--output", outFile],
  {
    stdio: "inherit",
  }
);

if (result.error) {
  console.error(`[types:gen] Failed to launch openapi-typescript: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
