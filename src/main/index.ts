import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { createEngineRegistry } from "./engine-registry.ts";
import { spawnPiEngine } from "./pi-process.ts";
import type { EngineInstance } from "./engine-instance.ts";
import type { ExtensionUiRequest } from "../shared/rpc-peer.ts";

/** ADR-0005：pi 是 vendored 依赖，cli.js 从我们自己的 node_modules 里取。
 * 用 import.meta.resolve（import 条件）而不是 require.resolve（require 条件），
 * 因为 pi 包的 exports 只声明了 `"import"`。 */
const piPackageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCliPath = join(dirname(dirname(piPackageEntry)), "dist", "bundle", "cli.js");

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

const engines = createEngineRegistry((workspace) => ({
  start: () => spawnPiEngine({ workspace, nodeExecPath: process.execPath, cliPath: piCliPath }),
  probeTimeoutMs: 30_000,
  stopGraceMs: 5_000,
  onEvent: (message) => broadcast("engine:event", { workspace, message }),
  onStatusChange: (status, instance) =>
    broadcast("engine:status", { workspace, status, pid: instance.pid }),
  onWarning: (error) => broadcast("engine:warning", { workspace, message: error.message }),
  onExtensionUiRequest: (request: ExtensionUiRequest) =>
    broadcast("engine:ui-request", { workspace, request }),
}));

function snapshot(instance: EngineInstance) {
  return { workspace: instance.workspace, status: instance.status, pid: instance.pid };
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: "pi-gui",
    backgroundColor: "#131312",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("workspace:open", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle("engine:start", async (_event, workspace: string) => {
    if (typeof workspace !== "string" || workspace.length === 0) {
      throw new Error("workspace 必须是非空字符串");
    }
    const instance = await engines.ensureStarted(workspace);
    return snapshot(instance);
  });

  ipcMain.handle("engine:prompt", async (_event, workspace: string, text: string, behavior: string | undefined) => {
    const response = await engines
      .get(workspace)
      .prompt(text, behavior === "steer" || behavior === "followUp" ? behavior : undefined);
    return { ok: response["success"] !== false };
  });

  ipcMain.handle("engine:abort", async (_event, workspace: string) => {
    const response = await engines.get(workspace).abort();
    return { ok: response["success"] !== false };
  });

  ipcMain.handle("engine:get-state", async (_event, workspace: string) => {
    return engines.get(workspace).getState();
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void engines.stopAll();
});