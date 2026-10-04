import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "data/**", "**/*.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs", "e2e/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // Hooks called conditionally or outside components are real bugs. Dependency lists are left to
    // review: several effects deliberately run once.
    files: ["apps/web/src/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error" },
  },
);
