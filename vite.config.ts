import { defineConfig } from "vite-plus"

export default defineConfig({
  fmt: { semi: false, printWidth: 100, ignorePatterns: ["rust/**", ".artifacts/**"] },
  lint: {
    ignorePatterns: ["**/dist/**", "**/coverage/**", "rust/**", ".artifacts/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
    options: { typeAware: true, typeCheck: true },
  },
  staged: { "*": "vp check --fix" },
  test: {
    projects: ["packages/zorsh"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/zorsh/src/**/*.ts"],
      exclude: ["packages/zorsh/src/index.ts", "packages/zorsh/src/types.ts"],
    },
  },
})
