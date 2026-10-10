import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// The app's own Vite config (SDK alias, `global` shim) plus a browser-like DOM.
export default mergeConfig(viteConfig, defineConfig({ test: { environment: "jsdom" } }));
