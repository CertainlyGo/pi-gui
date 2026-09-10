import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

/**
 * CSP 按模式注入（ADR-0004 的安全默认：渲染层会展示 agent 的原始输出，
 * 仓库内容是一次真实的脚本注入面）。
 *
 * 开发模式放宽给 vite HMR：react-refresh 内联 preamble、样式注入、ws 连接。
 * 生产模式收紧：脚本只信自己（打包产物），样式保留 'unsafe-inline'
 * （React 的 style 属性需要它），禁止一切远程连接 —— 渲染层不直接上网，
 * 网络能力只通过主进程的窄 IPC（插件搜索、凭据验证都在主进程）。
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws: http: https:",
  "font-src 'self' data:",
].join("; ");

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self' data:",
].join("; ");

function htmlCspPlugin(): Plugin {
  let dev = false;
  return {
    name: "pi-gui:html-csp",
    configResolved(config) {
      dev = config.command === "serve";
    },
    transformIndexHtml(html) {
      const csp = dev ? DEV_CSP : PROD_CSP;
      return html.replace(
        "<!--csp-injected-->",
        `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
      );
    },
  };
}

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
    plugins: [react(), htmlCspPlugin()],
  },
});