import globals from "globals";

export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        browser: "readonly",
        messenger: "readonly",
        jspdf: "readonly",
        NtcAuth: "readonly",
        NtcRpc: "readonly",
        NtcUtils: "readonly",
      }
    },
    rules: {
      "no-eval": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-unused-vars": ["warn", { "varsIgnorePattern": "^_", "argsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }],
      "no-undef": "error",
    }
  }
];
