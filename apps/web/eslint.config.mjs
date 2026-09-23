import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react/jsx-no-target-blank": ["error", { enforceDynamicLinks: "always" }],
    },
  },
  // `public/` is served verbatim, and holds the locally built live-demo
  // adapter bundle, which is generated output rather than source.
  globalIgnores([".next/**", "out/**", "public/**", "next-env.d.ts"]),
]);
