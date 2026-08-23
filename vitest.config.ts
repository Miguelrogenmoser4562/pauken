import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: [],
    coverage: {
      provider: "v8",
      include: ["src/lib/**"],
    },
  },
});
