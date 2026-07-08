import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure logic runs in node; DOM tests opt in per-file with
    // `// @vitest-environment jsdom` at the top of the file.
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/core/**", "src/tts/**", "src/reader/**"],
      reporter: ["text", "html"],
    },
  },
});
