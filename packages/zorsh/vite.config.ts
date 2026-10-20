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
    dts: true,
    sourcemap: true,
    clean: true,
    exports: false,
  },
})
