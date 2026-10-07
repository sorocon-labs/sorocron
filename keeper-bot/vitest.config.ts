import { defineConfig } from "vitest/config";

// Run tests against the SDK's TypeScript source in the workspace, so they
// never depend on a stale `packages/sdk/dist`.
export default defineConfig({
  resolve: { conditions: ["development"] },
  ssr: { resolve: { conditions: ["development"], externalConditions: ["development"] } },
  test: { server: { deps: { inline: ["@sorocron/sdk"] } } },
});
