import js from "@eslint/js";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
        crypto: "readonly",
        LumaState: "writable",
        LumaElements: "writable",
        LumaActions: "writable",
      },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", argsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: "error",
      "no-console": "off",
      "no-undef": "error",
    },
  },
  {
    // Ignore build artifacts and dependencies
    ignores: ["dist/*", "node_modules/*", "dist-types/*"],
  },
  eslintConfigPrettier,
];
