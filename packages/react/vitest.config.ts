import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    environment: "jsdom",
    server: { deps: { inline: ["@sorocron/sdk"] } },
  },
});
