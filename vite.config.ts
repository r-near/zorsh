import { recommended } from "@effect/tsgo/oxlint-presets"
import { defineConfig } from "vite-plus"

export default defineConfig({
  fmt: {
    useTabs: false,
    tabWidth: 2,
    printWidth: 100,
    singleQuote: false,
    semi: false,
    // Close to Biome's organize imports: packages before relative paths, no blank lines between.
    sortImports: {
      groups: [
        "builtin",
        "external",
        ["internal", "subpath"],
        ["parent", "sibling", "index"],
        "unknown",
      ],
      newlinesBetween: false,
    },
    ignorePatterns: ["rust/**", ".artifacts/**"],
  },
  lint: {
    extends: [recommended],
    ignorePatterns: ["**/dist/**", "**/coverage/**", "rust/**", ".artifacts/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Readability: every body is a block, and control flow stays flat and explicit.
      curly: ["error", "all"],
      "no-nested-ternary": "error",
      "no-else-return": ["error", { allowElseIf: false }],
      "no-lonely-if": "error",
      "no-param-reassign": "error",
      "no-sequences": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
    options: { typeAware: true, typeCheck: true },
  },
  staged: { "*": "vp check --fix" },
  test: {
    projects: ["packages/zorsh", "packages/effect"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/zorsh/src/**/*.ts", "packages/effect/src/**/*.ts"],
      exclude: ["packages/zorsh/src/index.ts", "packages/zorsh/src/types.ts"],
    },
  },
})
