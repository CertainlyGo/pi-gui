import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // sandbox: true 的 preload 只能是 CJS（Electron 限制），不能是 ESM。
    build: {
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "index.js" },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});