import { defineConfig } from "vite-plus"

export default defineConfig({
  test: { name: "zorsh", globals: true },
  pack: {
    entry: ["src/**/*.ts"],
    root: ".",
    outDir: "dist",
    unbundle: true,
    format: ["cjs"],
    platform: "node",
    fixedExtension: false,
    target: "es2022",
    dts: { sourcemap: false },
    sourcemap: true,
    // CJS declarations use a separate Rolldown build; only JavaScript needs maps.
    outputOptions(options, _format, { cjsDts }) {
      if (cjsDts) {
        options.sourcemap = false
      }
    },
    clean: true,
    exports: false,
  },
})
