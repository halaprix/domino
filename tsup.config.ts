import { defineConfig } from "tsup";

export default defineConfig([
  // Main bundle — full re-export
  {
    entry: ["src/index.ts"],
    outDir: "dist",
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    treeshake: true,
  },
  // viem engine — standalone tree-shakeable entry
  {
    entry: ["src/engines/viem.ts"],
    outDir: "dist/engines",
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    treeshake: true,
    outNames: "viem",
  },
  // ethers v6 engine
  {
    entry: ["src/engines/ethers-v6.ts"],
    outDir: "dist/engines",
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    treeshake: true,
    outNames: "ethers-v6",
  },
  // ethers v5 engine — external so the 180KB ethers-v5 lib is NOT bundled
  {
    entry: ["src/engines/ethers-v5.ts"],
    outDir: "dist/engines",
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    treeshake: true,
    outNames: "ethers-v5",
    external: ["ethers-v5"],
  },
]);