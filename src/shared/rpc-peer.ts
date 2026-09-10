import { encodeRecord } from "./rpc-frames.ts";

/** 扩展要的对话框方法：会阻塞扩展，等客户端回复。 */
export const DIALOG_UI_METHODS = ["select", "confirm", "input", "editor"] as const;

export type DialogUiMethod = (typeof DIALOG_UI_METHODS)[number];

/** 扩展的「发了就不等回复」方法：客户端可以展示，也可以忽略。 */
export const FIRE_AND_FORGET_UI_METHODS = [
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
] as const;

export interface ExtensionUiRequest {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method: string;
  readonly [key: string]: unknown;
}

export interface ExtensionUiResponse {
  readonly type: "extension_ui_response";
  readonly id: string;
  readonly [key: string]: unknown;
}

export function isExtensionUiRequest(value: unknown): value is ExtensionUiRequest {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record["type"] === "extension_ui_request" && typeof record["id"] === "string";
}

export function isDialogUiMethod(method: string): method is DialogUiMethod {
  return (DIALOG_UI_METHODS as readonly string[]).includes(method);
}

export class RpcCommandError extends Error {
  /** 出错的命令类型，用于把错误归因到具体操作。 */
  readonly command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.name = "RpcCommandError";
    this.command = command;
  }
}

export interface RpcRequestOptions {
  /** 该请求的超时毫秒数。0 或缺省表示不超时（默认，因为 prompt 可能跑很久）。 */
  readonly timeoutMs?: number;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (response: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export interface RpcPeerOptions {
  /** 写出一条已编码的记录（含结尾 LF）。 */
  readonly send: (record: string) => void;
  readonly newId?: () => string;
}

/**
 * RPC 请求-响应关联 + 事件路由。
 *
 * 按 `id` 关联响应；`success: false` 变成 rejected 的 {@link RpcCommandError}；
 * `extension_ui_request` 走单独的监听器（因为要回话），其余消息都是事件。
 */
export class RpcPeer {
  readonly #send: (record: string) => void;
  readonly #newId: () => string;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #eventListeners = new Set<(message: unknown) => void>();
  readonly #uiListeners = new Set<(request: ExtensionUiRequest) => void>();
  #counter = 0;
  #disposed = false;

  constructor(options: RpcPeerOptions) {
    this.#send = options.send;
    this.#newId = options.newId ?? (() => `gui-${++this.#counter}`);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  request(
    command: { readonly type: string } & Record<string, unknown>,
    options: RpcRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    if (this.#disposed) {
      return Promise.reject(new RpcCommandError("引擎已停止", command.type));
    }
    const id = this.#newId();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const pending: PendingRequest = { command: command.type, resolve, reject, timer: undefined };
      const timeoutMs = options.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new RpcCommandError(`命令超时（${timeoutMs}ms）：${command.type}`, command.type));
        }, timeoutMs);
        timer.unref();
        pending.timer = timer;
      }
      this.#pending.set(id, pending);
      this.#send(encodeRecord({ ...command, id }));
    });
  }

  /** 发一条不需要响应的命令。 */
  notify(command: { readonly type: string } & Record<string, unknown>): void {
    if (this.#disposed) return;
    this.#send(encodeRecord(command));
  }

  /** 回复扩展的对话框请求。 */
  respondToExtensionUi(response: ExtensionUiResponse): void {
    if (this.#disposed) return;
    this.#send(encodeRecord(response));
  }

  /** 处理一条来自引擎的记录：响应、扩展 UI 请求，或事件。 */
  handleMessage(message: unknown): void {
    if (message === null || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record["type"] === "response") {
      this.#settle(record);
      return;
    }
    if (isExtensionUiRequest(message)) {
      for (const listener of this.#uiListeners) listener(message);
      return;
    }
    for (const listener of this.#eventListeners) listener(message);
  }

  /** 订阅引擎事件（除响应与扩展 UI 请求之外的一切）。返回取消订阅函数。 */
  onEvent(listener: (message: unknown) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onExtensionUiRequest(listener: (request: ExtensionUiRequest) => void): () => void {
    this.#uiListeners.add(listener);
    return () => this.#uiListeners.delete(listener);
  }

  /** 引擎消失时调用：所有在途请求都会被拒，不留下悬空的 Promise。 */
  dispose(reason = "引擎已停止"): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.reject(new RpcCommandError(reason, entry.command));
    }
    this.#eventListeners.clear();
    this.#uiListeners.clear();
  }

  #settle(record: Record<string, unknown>): void {
    const id = record["id"];
    if (typeof id !== "string") return; // 没有 id 的响应无法关联，忽略
    const pending = this.#pending.get(id);
    if (pending === undefined) return; // 迟到的响应：安静丢弃
    this.#pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);

    if (record["success"] === false) {
      const detail = typeof record["error"] === "string" ? record["error"] : "命令失败";
      pending.reject(new RpcCommandError(detail, pending.command));
      return;
    }
    pending.resolve(record);
  }
}
