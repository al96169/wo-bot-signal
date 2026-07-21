import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["node_modules/", "dist/"],
  },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-empty": "off",
      "no-case-declarations": "off",
    },
  },

  eslintConfigPrettier,
);
