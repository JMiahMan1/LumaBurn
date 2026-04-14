module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  extends: ["eslint:recommended"],
  rules: {
    "no-unused-vars": ["error", { args: "none" }],
    "no-var": "error",
    "prefer-const": "error",
    semi: ["error", "always"],
    quotes: ["error", "single", { avoidEscape: true }],
    indent: ["error", 2],
    eqeqeq: "error",
    curly: ["error", "all"],
  },
};
