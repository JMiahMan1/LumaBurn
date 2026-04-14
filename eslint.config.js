import js from "@eslint/js";
import globals from "globals";

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
        LumaActions: "writable"
      },
    },
    rules: {
      "no-unused-vars": ["error", { args: "none", argsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "error",
      "semi": ["error", "always"],
      "quotes": ["error", "single", { avoidEscape: true }],
      "indent": ["error", 2],
      "eqeqeq": "error",
      "curly": ["error", "all"],
      "no-console": "off",
      "no-undef": "error"
    },
  },
  {
    // Ignore build artifacts and dependencies
    ignores: ["dist/*", "node_modules/*", "dist-types/*"]
  }
];
