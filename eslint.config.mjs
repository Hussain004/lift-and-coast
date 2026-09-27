import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Rendered video artifacts, gitignored. They vendor a minified GSAP
    // build, which linted as 16 no-this-alias errors on every run and
    // buried any real finding.
    "brag-output/**",
    "brag-output-chaotic/**",
  ]),
]);

export default eslintConfig;
