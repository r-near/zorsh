import { defineConfig } from "vite-plus"

export default defineConfig({
  test: { name: "effect" },
  pack: {
    entry: ["src/index.ts", "src/Borsh.ts"],
    outDir: "dist",
    format: ["esm"],
    platform: "neutral",
    target: "es2022",
    dts: { sourcemap: false },
    clean: true,
    exports: false,
  },
})
