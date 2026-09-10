/**
 * renderer ↔ main 的 IPC 契约。
 *
 * 这是唯一的桥面：渲染层只能通过 preload 暴露的这些通道触达引擎，
 * 不允许拿到任何 Node 能力（ADR-0004 的安全默认）。
 * 类型在 preload 与 renderer 之间共享，避免两边各写一份。
 */

import type { ExtensionUiRequest } from "./rpc-peer.ts";

/** invoke 通道的返回体。 */
export interface EngineStatusSnapshot {
  readonly workspace: string;
  readonly status: string;
  readonly pid: number | undefined;
}

/** main → renderer 推送的引擎事件载荷。 */
export interface EngineEventPayload<M = unknown> {
  readonly workspace: string;
  /** 引擎事件原始记录（如 message_update、tool_execution_start）。 */
  readonly message: M;
}

export interface EngineUiRequestPayload {
  readonly workspace: string;
  readonly request: ExtensionUiRequest;
}

export interface EngineWarningPayload {
  readonly workspace: string;
  readonly message: string;
}

export interface PiGuiApi {
  openWorkspace(): Promise<string | null>;
  startEngine(workspace: string): Promise<EngineStatusSnapshot>;
  /**
   * 发送用户消息。引擎正在跑时必须给插话/排队行为，否则协议会拒绝。
   * `steer` = 插话（当前回合跑完就处理），`followUp` = 排队（完全停下再处理）。
   */
  prompt(
    workspace: string,
    text: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<{ ok: boolean }>;
  abort(workspace: string): Promise<{ ok: boolean }>;
  getState(workspace: string): Promise<Record<string, unknown>>;
  onEngineEvent(listener: (payload: EngineEventPayload) => void): () => void;
  onStatus(listener: (payload: EngineStatusSnapshot) => void): () => void;
  onWarning(listener: (payload: EngineWarningPayload) => void): () => void;
  onUiRequest(listener: (payload: EngineUiRequestPayload) => void): () => void;
}