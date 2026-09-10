import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { createEngineRegistry } from "./engine-registry.ts";
import { spawnPiEngine } from "./pi-process.ts";
import { checkProviderAuth, loadAuthFile, removeCredential, saveCredential } from "./credentials.ts";
import type { EngineInstance } from "./engine-instance.ts";
import type { ExtensionUiRequest } from "../shared/rpc-peer.ts";
import type { AuthSetOutcome, CredentialInfo } from "../shared/ipc-contract.ts";

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

function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `••••${key.slice(-4)}`;
}

function readObj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function modelField(model: Record<string, unknown>, key: string): string | undefined {
  const value = model[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    title: "pi-gui",
    backgroundColor: "#131312",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 开发模式下 F12 开关 DevTools（菜单被移除，默认快捷键没了）。
  if (!app.isPackaged) {
    window.webContents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown" && input.key === "F12") {
        window.webContents.toggleDevTools();
      }
    });
  }

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  // 用户要求：删掉 File/Edit/View 菜单栏。
  Menu.setApplicationMenu(null);

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

  ipcMain.handle("engine:get-stats", async (_event, workspace: string) => {
    const instance = engines.get(workspace);
    if (instance.status !== "ready") return null;
    return await instance.getSessionStats() ?? null;
  });

  ipcMain.handle("engine:get-models", async (_event, workspace: string) => {
    const instance = engines.get(workspace);
    if (instance.status !== "ready") return null;
    const models = (await instance.listModels()).map((model) => ({
      id: modelField(model, "id") ?? "unknown",
      name: modelField(model, "name") ?? modelField(model, "id") ?? "未知模型",
      provider: modelField(model, "provider") ?? "?",
    }));
    let thinkingLevels: readonly string[] = ["off"];
    try {
      const levels = await instance.listThinkingLevels();
      if (levels.length > 0) thinkingLevels = levels;
    } catch {
      // 当前模型不支持思考时保持 ["off"]
    }
    const state = await instance.getState();
    const stateData = readObj(state["data"]);
    const model = readObj(stateData["model"]);
    const current: { modelId?: string; provider?: string; thinkingLevel?: string } = {};
    const modelId = modelField(model, "id");
    if (modelId !== undefined) {
      current["modelId"] = modelId;
      const provider = modelField(model, "provider");
      if (provider !== undefined) current["provider"] = provider;
    }
    const thinkingLevel = stateData["thinkingLevel"];
    if (typeof thinkingLevel === "string") current["thinkingLevel"] = thinkingLevel;
    return { models, thinkingLevels, current };
  });

  ipcMain.handle("engine:set-model", async (_event, workspace: string, provider: string, modelId: string) => {
    try {
      await engines.get(workspace).setModel(provider, modelId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle("engine:set-thinking", async (_event, workspace: string, level: string) => {
    try {
      await engines.get(workspace).setThinkingLevel(level);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ---- 凭据（账号页）----
  const authPath = join(homedir(), ".pi", "agent", "auth.json");

  ipcMain.handle("auth:list", async (): Promise<CredentialInfo[]> => {
    const auth = await loadAuthFile(authPath);
    return Object.entries(auth).map(([provider, credential]) => ({
      provider,
      type: credential.type,
      keyMasked: maskKey(credential.key),
    }));
  });

  ipcMain.handle("auth:set", async (_event, provider: string, key: string): Promise<AuthSetOutcome> => {
    if (typeof provider !== "string" || provider.trim().length === 0) {
      return { ok: false, error: "provider 不能为空" };
    }
    if (typeof key !== "string" || key.trim().length === 0) {
      return { ok: false, error: "密钥不能为空" };
    }
    try {
      await saveCredential(authPath, provider.toLowerCase(), { type: "api_key", key: key.trim() });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const check = await checkProviderAuth({
      nodeExecPath: process.execPath,
      cliPath: piCliPath,
      provider: provider.toLowerCase(),
    });
    return { ok: true, check };
  });

  ipcMain.handle("auth:remove", async (_event, provider: string): Promise<boolean> => {
    return removeCredential(authPath, provider);
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