import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-debugger": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
    },
  },
];
