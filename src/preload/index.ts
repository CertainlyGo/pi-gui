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
  listCredentials: () => ipcRenderer.invoke("auth:list"),
  setCredential: (provider, key) => ipcRenderer.invoke("auth:set", provider, key),
  removeCredential: (provider) => ipcRenderer.invoke("auth:remove", provider),
  onEngineEvent: (listener) => subscribe("engine:event", listener),
  onStatus: (listener) => subscribe("engine:status", listener),
  onWarning: (listener) => subscribe("engine:warning", listener),
  onUiRequest: (listener) => subscribe("engine:ui-request", listener),
};

contextBridge.exposeInMainWorld("piGui", api);