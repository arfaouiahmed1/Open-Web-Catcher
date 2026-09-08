import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals"),
  {
    files: [
      "components/tool-call-feed.js",
      "components/trace-explorer.js",
      "components/console/run-detail/browser-live-view.js",
    ],
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
];

export default eslintConfig;
