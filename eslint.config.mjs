import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Fetch-on-mount via useEffect is the standard, well-understood pattern
      // used across the app's API-backed pages; this experimental React
      // Compiler rule flags it even when the setState call is properly
      // deferred (async/.catch()). Not worth fighting for a 9h/week solo repo.
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Reference prototype only (CLAUDE.md: "not production code") — not linted.
    "prototypes/**",
  ]),
]);

export default eslintConfig;
