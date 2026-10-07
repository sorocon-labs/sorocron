import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves the site from /<repo>/; set BASE_PATH there.
  base: process.env.BASE_PATH ?? "/",
  resolve: {
    // Use the SDK's TypeScript source directly so the app needs no SDK build step.
    alias: {
      "@sorocron/sdk": fileURLToPath(new URL("../packages/sdk/src/index.ts", import.meta.url)),
    },
  },
  define: { global: "globalThis" },
});
