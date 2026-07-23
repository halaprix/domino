import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@halaprix/domino": path.resolve(__dirname, "./dist/index.js"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/compat/**/*.test.ts"],
    setupFiles: ["./src/__tests__/setup/unhandled-rejections.ts"],
  },
});
