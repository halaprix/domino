import { defineConfig } from "tsup";

export default defineConfig([
  // v2: Single entry point — Eip1193Executor + handlers + bytecodes.
  // viem/utils is external (tree-shaken by consumer's bundler).
  {
    entry: ["src/index.ts"],
    outDir: "dist",
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    treeshake: true,
    external: ["viem", "viem/utils"],
  },
]);
