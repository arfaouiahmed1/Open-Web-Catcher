import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["app", "components", "lib"];
const LEGACY_CONFIG_FILES = ["postcss.config.js", "tailwind.config.js"];
const LEGACY_EXTENSIONS = new Set([".js", ".jsx"]);

function legacySourceFiles(root: string, directory = join(process.cwd(), root)): string[] {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return legacySourceFiles(root, path);
    return LEGACY_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))
      ? [relative(process.cwd(), path).replaceAll("\\", "/")]
      : [];
  });
}

describe("frontend source migration", () => {
  it("contains no JavaScript or JSX implementation files", () => {
    const remaining = [
      ...SOURCE_ROOTS.flatMap((root) => legacySourceFiles(root)),
      ...LEGACY_CONFIG_FILES.filter((path) => existsSync(join(process.cwd(), path))),
    ];

    expect(remaining).toEqual([]);
  });

  it("configures the component generator for TypeScript", () => {
    const componentsConfig = JSON.parse(
      readFileSync(join(process.cwd(), "components.json"), "utf8"),
    ) as { tsx?: boolean; tailwind?: { config?: string } };

    expect(componentsConfig.tsx).toBe(true);
    expect(componentsConfig.tailwind?.config).toBe("tailwind.config.ts");
  });
});
