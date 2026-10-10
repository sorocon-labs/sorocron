import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// The app's own Vite config (SDK alias, `global` shim) plus a browser-like DOM.
// Accessibility scans are slow in jsdom, so tests get more than the default 5s.
export default mergeConfig(viteConfig, defineConfig({ test: { environment: "jsdom", testTimeout: 20_000 } }));
