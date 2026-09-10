import { JsonlDecoder } from "../shared/rpc-frames.ts";
import { RpcPeer } from "../shared/rpc-peer.ts";
import type { ExtensionUiRequest } from "../shared/rpc-peer.ts";

/**
 * Engine 实例的状态机。
 *
 * idle → starting → ready → stopping → stopped
 *                     ↘ crashed（进程异常退出/启动探测失败）
 */
export type EngineStatus = "idle" | "starting" | "ready" | "stopping" | "stopped" | "crashed";

export interface EngineExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * 一个已启动的引擎子进程。真实实现见 `pi-process.ts`；
 * 测试里用假实现，因此这里只暴露监督所需的最小接口。
 */
export interface EngineProcess {
  readonly pid: number | undefined;
  write(record: string): void;
  endInput(): void;
  kill(): void;
  killTree(): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (info: EngineExitInfo) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface EngineInstanceOptions {
  /** 这个引擎所属的 Workspace（绝对路径），同时作为子进程的 cwd。 */
  readonly workspace: string;
  /** 真正启动子进程。只在 start() 时调用一次。 */
  readonly start: () => EngineProcess;
  /** 用于启动探测的命令类型。默认 get_state。 */
  readonly probeType?: string;
  /** 启动探测超时，毫秒。 */
  readonly probeTimeoutMs?: number;
  /** 停止时每阶段的宽限时间，毫秒。 */
  readonly stopGraceMs?: number;
  /** 判定空闲回收的阈值，毫秒。 */
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
  readonly onEvent?: (message: unknown) => void;
  readonly onStatusChange?: (status: EngineStatus, instance: EngineInstance) => void;
  readonly onExtensionUiRequest?: (request: ExtensionUiRequest) => void;
  /** 协议层面的问题（坏记录、stderr 异常）。不致命，但要能让用户看见。 */
  readonly onWarning?: (error: Error) => void;
}

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_TAIL_LIMIT = 8 * 1024;

/**
 *  supervise 一个绑定到单个 Workspace 的 pi 引擎子进程。
 *
 * 这里只做四件事：拉起进程、把字节流接进 {@link RpcPeer}、把退出/错误翻译成状态、
 * 以及在停止时按宽限→kill→killTree 的顺序收尾。任何业务语义都不在这里。
 */
export class EngineInstance {
  readonly workspace: string;
  readonly #options: EngineInstanceOptions;
  readonly #idleTimeoutMs: number;
  readonly #stopGraceMs: number;
  readonly #probeType: string;
  readonly #probeTimeoutMs: number;
  readonly #now: () => number;

  #status: EngineStatus = "idle";
  #child: EngineProcess | undefined;
  #peer: RpcPeer | undefined;
  #decoder = new JsonlDecoder();
  #stderrTail = "";
  #lastActivityAt: number;
  #exitInfo: EngineExitInfo | undefined;
  #exitWaiters: Array<(info: EngineExitInfo | undefined) => void> = [];

  constructor(options: EngineInstanceOptions) {
    this.workspace = options.workspace;
    this.#options = options;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.#probeType = options.probeType ?? "get_state";
    this.#probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#lastActivityAt = this.#now();
  }

  get status(): EngineStatus {
    return this.#status;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** 引擎进程的 stderr 末尾（有界）。启动失败时用它解释原因。 */
  get stderrTail(): string {
    return this.#stderrTail;
  }

  get lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  get peer(): RpcPeer {
    if (this.#peer === undefined) {
      throw new Error(`引擎尚未启动：${this.workspace}`);
    }
    return this.#peer;
  }

  /** 启动并确认它真的活着。重复调用是幂等的。 */
  async start(): Promise<void> {
    if (this.#status === "starting" || this.#status === "ready") return;
    if (this.#status === "stopping") {
      throw new Error(`引擎正在停止，无法启动：${this.workspace}`);
    }

    this.#exitInfo = undefined;
    this.#decoder = new JsonlDecoder();
    this.#setStatus("starting");

    let child: EngineProcess;
    try {
      child = this.#options.start();
    } catch (error) {
      this.#setStatus("crashed");
      throw error;
    }
    this.#child = child;

    const peer = new RpcPeer({ send: (record) => child.write(record) });
    this.#peer = peer;
    peer.onEvent((message) => {
      this.#lastActivityAt = this.#now();
      this.#options.onEvent?.(message);
    });
    peer.onExtensionUiRequest((request) => {
      this.#lastActivityAt = this.#now();
      this.#options.onExtensionUiRequest?.(request);
    });

    child.onStdout((chunk) => this.#handleStdout(chunk));
    child.onStderr((chunk) => this.#handleStderr(chunk));
    child.onExit((info) => this.#handleExit(info));
    child.onError((error) => {
      this.#options.onWarning?.(error);
      this.#setStatus("crashed");
    });

    try {
      await peer.request({ type: this.#probeType }, { timeoutMs: this.#probeTimeoutMs });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const stderr = this.#stderrTail.trim();
      await this.stop();
      this.#setStatus("crashed");
      throw new Error(
        `引擎启动失败：${detail}${stderr.length > 0 ? `\n--- stderr ---\n${stderr}` : ""}`,
      );
    }

    this.#lastActivityAt = this.#now();
    this.#setStatus("ready");
  }

  /** 按 宽限 → kill → killTree 的顺序停止。重复调用是幂等的。 */
  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) {
      this.#setStatus("stopped");
      return;
    }
    if (this.#status === "stopping") {
      await this.#waitForExit(this.#stopGraceMs * 2);
      return;
    }

    this.#setStatus("stopping");
    this.#peer?.dispose("引擎正在停止");
    child.endInput();

    if (await this.#waitForExit(this.#stopGraceMs)) return;
    child.kill();
    if (await this.#waitForExit(this.#stopGraceMs)) return;
    child.killTree();
    this.#child = undefined;
    this.#setStatus("stopped");
  }

  /** 是否已经空闲到可以被回收（只在 ready 状态下才算）。 */
  isIdle(): boolean {
    return this.#status === "ready" && this.#now() - this.#lastActivityAt >= this.#idleTimeoutMs;
  }

  get idleTimeoutMs(): number {
    return this.#idleTimeoutMs;
  }

  prompt(text: string, streamingBehavior?: "steer" | "followUp"): Promise<Record<string, unknown>> {
    return this.peer.request({
      type: "prompt",
      message: text,
      ...(streamingBehavior !== undefined ? { streamingBehavior } : {}),
    });
  }

  abort(): Promise<Record<string, unknown>> {
    return this.peer.request({ type: "abort" });
  }

  getState(): Promise<Record<string, unknown>> {
    return this.peer.request({ type: "get_state" });
  }

  /** session 级用量统计（token、费用、上下文占用），见 rpc.md get_session_stats。 */
  getSessionStats(): Promise<Record<string, unknown> | undefined> {
    return this.peer.request({ type: "get_session_stats" }).then((response) => {
      const data = (response as Record<string, unknown>)["data"];
      return data === null || typeof data !== "object" ? undefined : (data as Record<string, unknown>);
    });
  }

  listModels(): Promise<readonly Record<string, unknown>[]> {
    return this.peer.request({ type: "get_available_models" }).then((response) => {
      const data = (response as Record<string, unknown>)["data"];
      const models = data !== null && typeof data === "object"
        ? (data as Record<string, unknown>)["models"]
        : undefined;
      return Array.isArray(models)
        ? (models as readonly Record<string, unknown>[])
        : [];
    });
  }

  setModel(provider: string, modelId: string): Promise<Record<string, unknown>> {
    return this.peer.request({ type: "set_model", provider, modelId });
  }

  listThinkingLevels(): Promise<readonly string[]> {
    return this.peer.request({ type: "get_available_thinking_levels" }).then((response) => {
      const data = (response as Record<string, unknown>)["data"];
      const levels = data !== null && typeof data === "object"
        ? (data as Record<string, unknown>)["levels"]
        : undefined;
      return Array.isArray(levels) ? (levels as readonly string[]) : ["off"];
    });
  }

  setThinkingLevel(level: string): Promise<Record<string, unknown>> {
    return this.peer.request({ type: "set_thinking_level", level });
  }

  /** 加载另一个 session 文件（可能被扩展的 before_switch 处理器取消）。 */
  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const response = await this.peer.request({ type: "switch_session", sessionPath });
    const data = (response as Record<string, unknown>)["data"];
    const cancelled =
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>)["cancelled"] === true
        : false;
    return { cancelled };
  }

  /** 回复扩展的对话框请求（Extension UI Protocol）。 */
  respondExtensionUi(id: string, response: Record<string, unknown>): void {
    this.peer.respondToExtensionUi({ type: "extension_ui_response", id, ...response });
  }

  #handleStdout(chunk: string): void {
    const outcome = this.#decoder.push(chunk);
    for (const error of outcome.errors) this.#options.onWarning?.(error);
    for (const record of outcome.records) {
      this.#lastActivityAt = this.#now();
      this.#peer?.handleMessage(record);
    }
  }

  #handleStderr(chunk: string): void {
    this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
  }

  #handleExit(info: EngineExitInfo): void {
    this.#exitInfo = info;
    const leftover = this.#decoder.end();
    for (const error of leftover.errors) this.#options.onWarning?.(error);
    this.#peer?.dispose(`引擎已退出（code=${info.code ?? "null"}）`);

    const expected = this.#status === "stopping";
    this.#setStatus(expected ? "stopped" : info.code === 0 ? "stopped" : "crashed");

    const waiters = this.#exitWaiters;
    this.#exitWaiters = [];
    for (const waiter of waiters) waiter(info);
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#exitInfo !== undefined) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const index = this.#exitWaiters.indexOf(waiter);
        if (index !== -1) this.#exitWaiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      const waiter = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.#exitWaiters.push(waiter);
    });
  }

  #setStatus(status: EngineStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.onStatusChange?.(status, this);
  }
}
