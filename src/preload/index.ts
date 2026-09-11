import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { PiGuiApi } from "../shared/ipc-contract.ts";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: PiGuiApi = {
  openWorkspace: () => ipcRenderer.invoke("workspace:open") as Promise<string | null>,
  startEngine: (workspace) => ipcRenderer.invoke("engine:start", workspace),
  prompt: (workspace, text, streamingBehavior) =>
    ipcRenderer.invoke("engine:prompt", workspace, text, streamingBehavior),
  abort: (workspace) => ipcRenderer.invoke("engine:abort", workspace),
  getState: (workspace) => ipcRenderer.invoke("engine:get-state", workspace),
  getStats: (workspace) => ipcRenderer.invoke("engine:get-stats", workspace),
  getModels: (workspace) => ipcRenderer.invoke("engine:get-models", workspace),
  setModel: (workspace, provider, modelId) =>
    ipcRenderer.invoke("engine:set-model", workspace, provider, modelId),
  setThinkingLevel: (workspace, level) =>
    ipcRenderer.invoke("engine:set-thinking", workspace, level),
  listCredentials: () => ipcRenderer.invoke("auth:list"),
  setApiCredential: (format, baseUrl, key) =>
    ipcRenderer.invoke("auth:set-api", format, baseUrl, key),
  removeCredential: (provider) => ipcRenderer.invoke("auth:remove", provider),
  trustState: (workspace) => ipcRenderer.invoke("trust:state", workspace),
  decideTrust: (workspace, decision) => ipcRenderer.invoke("trust:decide", workspace, decision),
  listSessions: (workspace) => ipcRenderer.invoke("sessions:list", workspace),
  switchSession: (workspace, sessionPath) =>
    ipcRenderer.invoke("engine:switch-session", workspace, sessionPath),
  deleteSession: (workspace, sessionPath) =>
    ipcRenderer.invoke("sessions:delete", workspace, sessionPath),
  newSession: (workspace) => ipcRenderer.invoke("engine:new-session", workspace),
  forkFromMessage: (workspace, entryId) =>
    ipcRenderer.invoke("engine:fork", workspace, entryId),
  getMessages: (workspace) => ipcRenderer.invoke("engine:get-messages", workspace),
  setSessionName: (workspace, name) =>
    ipcRenderer.invoke("engine:set-session-name", workspace, name),
  searchPackages: (query) => ipcRenderer.invoke("market:search", query),
  listPackages: () => ipcRenderer.invoke("market:list"),
  installPackage: (spec, scope, workspace) =>
    ipcRenderer.invoke("market:install", spec, scope, workspace),
  updatePackage: (spec, scope, workspace) =>
    ipcRenderer.invoke("market:update", spec, scope, workspace),
  removePackage: (spec, scope, workspace) =>
    ipcRenderer.invoke("market:remove", spec, scope, workspace),
  respondUi: (workspace, requestId, response) =>
    ipcRenderer.invoke("engine:respond-ui", workspace, requestId, response),
  oauthLogin: (provider) => ipcRenderer.invoke("auth:oauth-login", provider),
  oauthCancel: () => {
    void ipcRenderer.invoke("auth:oauth-cancel");
  },
  respondOAuthPrompt: (id, value) => {
    void ipcRenderer.invoke("auth:prompt-response", id, value);
  },
  onOAuthPrompt: (listener) => subscribe("auth:prompt", listener),
  onOAuthNotify: (listener) => subscribe("auth:notify", listener),
  onEngineEvent: (listener) => subscribe("engine:event", listener),
  onStatus: (listener) => subscribe("engine:status", listener),
  onWarning: (listener) => subscribe("engine:warning", listener),
  onUiRequest: (listener) => subscribe("engine:ui-request", listener),
};

contextBridge.exposeInMainWorld("piGui", api);