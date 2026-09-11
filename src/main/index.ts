import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, net } from "electron";
import { createEngineRegistry } from "./engine-registry.ts";
import { spawnPiEngine } from "./pi-process.ts";
import { checkProviderAuth, loadAuthFile, removeCredential, saveCredential } from "./credentials.ts";
import { createTrustStore, detectTrustResources } from "./trust.ts";
import { deleteSessionFile, listWorkspaceSessions } from "./sessions.ts";
import { OAUTH_PROVIDERS, handleAuthNotifyForBrowser, runOAuthLogin } from "./oauth.ts";
import type { OAuthProvider } from "./oauth.ts";
import {
  installPiPackage,
  listInstalledPackages,
  removePiPackage,
  searchPiPackages,
  updatePiPackage,
} from "./marketplace.ts";
import type { EngineInstance } from "./engine-instance.ts";
import type { ExtensionUiRequest } from "../shared/rpc-peer.ts";
import type { Credential } from "./credentials.ts";
import type { AuthSetOutcome, CredentialInfo, OAuthPromptMessage } from "../shared/ipc-contract.ts";

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

function isOAuthProvider(value: unknown): value is OAuthProvider {
  return (
    typeof value === "string" &&
    (OAUTH_PROVIDERS as readonly { id: OAuthProvider; label: string }[]).some(
      (entry) => entry.id === value,
    )
  );
}

/** auth.json 的 provider 键：codex 类账号在 ai 里的命名是 openai-codex。 */
function providerIdToCredentialKey(provider: OAuthProvider): string {
  return provider;
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
      keyMasked:
        credential.type === "oauth" ? "OAuth 令牌" : maskKey(credential.key),
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

  // ---- 项目信任（ADR-0006）----
  const agentDir = join(homedir(), ".pi", "agent");
  const trust = createTrustStore(agentDir);

  ipcMain.handle("trust:state", (_event, workspace: string) => {
    const resources = detectTrustResources(workspace);
    const decision = trust.decision(workspace);
    return {
      resources,
      decision,
      decided: resources.length === 0 || decision === "always" || decision === "never",
    };
  });

  ipcMain.handle("trust:decide", (_event, workspace: string, decision: "always" | "never") => {
    try {
      trust.decide(workspace, decision);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ---- session 列表与切换 ----
  ipcMain.handle("sessions:list", (_event, workspace: string) => {
    return listWorkspaceSessions(agentDir, workspace);
  });

  ipcMain.handle("engine:switch-session", async (_event, workspace: string, sessionPath: string) => {
    const instance = engines.get(workspace);
    if (instance.status !== "ready") return { ok: false, cancelled: false, error: "引擎未就绪" };
    const { cancelled } = await instance.switchSession(sessionPath);
    return { ok: true, cancelled };
  });

  ipcMain.handle("sessions:delete", (_event, workspace: string, sessionPath: string) => {
    return deleteSessionFile(agentDir, workspace, sessionPath);
  });

  ipcMain.handle("engine:new-session", async (_event, workspace: string) => {
    const instance = engines.get(workspace);
    if (instance.status !== "ready") return { ok: false, cancelled: false, error: "引擎未就绪" };
    const { cancelled } = await instance.newSession();
    return { ok: true, cancelled };
  });

  ipcMain.handle("engine:fork", async (_event, workspace: string, entryId: string) => {
    const instance = engines.get(workspace);
    if (instance.status !== "ready") return { ok: false, cancelled: false, error: "引擎未就绪" };
    const { cancelled } = await instance.fork(entryId);
    return { ok: true, cancelled };
  });

  ipcMain.handle("engine:get-messages", async (_event, workspace: string) => {
    const instance = engines.get(workspace);
    if (instance.status !== "ready") return [];
    return instance.getMessages();
  });

  // ---- 插件市场 ----
  ipcMain.handle("market:search", async (_event, query: string) => {
    // 用 Electron 自己的网络栈（走系统代理），外部的 Node fetch 在这台机器上会超时。
    const fetchViaElectron = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
      net.fetch(input as RequestInfo, init);
    return searchPiPackages(query, 24, fetchViaElectron);
  });

  ipcMain.handle("market:list", async () => {
    return listInstalledPackages(agentDir, "");
  });

  ipcMain.handle("market:install", async (_event, spec: string, scope: "global" | "project", workspace: string) => {
    const cwd = scope === "project" ? workspace : homedir();
    return installPiPackage({ nodeExecPath: process.execPath, cliPath: piCliPath, spec, scope, cwd });
  });

  ipcMain.handle("market:update", async (_event, spec: string, scope: "global" | "project", workspace: string) => {
    const cwd = scope === "project" ? workspace : homedir();
    return updatePiPackage({ nodeExecPath: process.execPath, cliPath: piCliPath, spec, scope, cwd });
  });

  ipcMain.handle("market:remove", async (_event, spec: string, scope: "global" | "project", workspace: string) => {
    const cwd = scope === "project" ? workspace : homedir();
    return removePiPackage({ nodeExecPath: process.execPath, cliPath: piCliPath, spec, scope, cwd });
  });

  // ---- 扩展对话框（Extension UI Protocol）----
  ipcMain.handle("engine:respond-ui", (_event, workspace: string, requestId: string, response: Record<string, unknown>) => {
    engines.get(workspace).respondExtensionUi(requestId, response);
    return { ok: true };
  });

  // ---- OAuth 订阅登录 ----
  const oauthPendingPrompts = new Map<
    string,
    { resolve: (value: string) => void; reject: (error: Error) => void }
  >();
  let oauthPromptSeq = 0;
  let oauthController: AbortController | undefined;

  function broadcastPrompt(message: OAuthPromptMessage): void {
    broadcast("auth:prompt", message);
  }

  ipcMain.handle("auth:oauth-login", async (_event, provider: string) => {
    if (!isOAuthProvider(provider)) {
      return { ok: false, provider, error: `未知的登录提供商：${provider}` };
    }
    oauthController?.abort();
    oauthController = new AbortController();
    const signal = oauthController.signal;
    try {
      const credential = await runOAuthLogin(
        provider,
        {
          onPrompt: (prompt) =>
            new Promise<string>((resolve, reject) => {
              const id = `p-${++oauthPromptSeq}`;
              oauthPendingPrompts.set(id, { resolve, reject });
              broadcastPrompt({
                id,
                type: prompt.type,
                message: prompt.message,
                ...("placeholder" in prompt && typeof prompt["placeholder"] === "string"
                  ? { placeholder: prompt["placeholder"] }
                  : {}),
                ...("options" in prompt ? { options: prompt.options } : {}),
              });
            }),
          onNotify: (event) => {
            const opened = handleAuthNotifyForBrowser(event);
            broadcast("auth:notify", {
              type: event.type,
              ...("message" in event && typeof event.message === "string" ? { message: event.message } : {}),
              ...("url" in event && typeof event.url === "string" ? { url: event.url } : {}),
              ...("instructions" in event && typeof event.instructions === "string"
                ? { instructions: event.instructions }
                : {}),
              ...("userCode" in event && typeof event.userCode === "string" ? { userCode: event.userCode } : {}),
              ...("verificationUri" in event && typeof event.verificationUri === "string"
                ? { verificationUri: event.verificationUri }
                : {}),
              ...(opened ? { message: "已在浏览器中打开授权页" } : {}),
            });
          },
        },
        signal,
      );
      await saveCredential(authPath, providerIdToCredentialKey(provider), credential as unknown as Credential);
      const check = await checkProviderAuth({
        nodeExecPath: process.execPath,
        cliPath: piCliPath,
        provider: providerIdToCredentialKey(provider),
      });
      return { ok: true, provider, check };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, provider, error: message };
    } finally {
      oauthController = undefined;
    }
  });

  ipcMain.handle("auth:prompt-response", (_event, id: string, value: string | null) => {
    const pending = oauthPendingPrompts.get(id);
    oauthPendingPrompts.delete(id);
    if (pending === undefined) return;
    if (value === null) pending.reject(new Error("登录被取消"));
    else pending.resolve(value);
  });

  ipcMain.handle("auth:oauth-cancel", () => {
    oauthController?.abort();
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