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

/** get_session_stats 的响应 data（rpc.md），字段全部可选，渲染层按 0/缺省兜底。 */
export interface SessionStatsData {
  readonly tokens?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
  readonly cost?: number;
  readonly contextUsage?: {
    readonly tokens?: number | null;
    readonly contextWindow?: number;
    readonly percent?: number | null;
  };
}

/** 账号页里一个已配置的 provider（key 只露尾巴）。 */
export interface CredentialInfo {
  readonly provider: string;
  readonly type: string;
  readonly keyMasked: string;
}

export interface AuthCheckOutcome {
  readonly ok: boolean;
  readonly status: "ready" | "not_ready" | "error";
  readonly reason?: string;
  readonly message?: string;
}

export interface AuthSetOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly check?: AuthCheckOutcome;
}

/** 模型选择器用到的数据：模型清单 + 思考等级 + 当前选择。 */
export interface ModelPickerData {
  readonly models: readonly {
    readonly id: string;
    readonly name: string;
    readonly provider: string;
  }[];
  readonly thinkingLevels: readonly string[];
  readonly current: {
    readonly modelId?: string;
    readonly provider?: string;
    readonly thinkingLevel?: string;
  };
}

/** 需要信任决策的项目资源。 */
export interface TrustState {
  readonly resources: readonly string[];
  readonly decision: string | null;
  readonly decided: boolean;
}

export interface SessionSummary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly updatedAt: number;
}

export interface MarketPackage {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly publisher: string;
  readonly updatedAt: string;
  readonly downloadsLastWeek: number;
}

export interface CliOutcome {
  readonly ok: boolean;
  readonly error?: string;
}

/** OAuth 登录时，主进程会弹给渲染层的提示请求。 */
export interface OAuthPromptMessage {
  readonly id: string;
  readonly type: string;
  readonly message: string;
  readonly placeholder?: string;
  readonly options?: readonly { id: string; label: string; description?: string }[];
}

/** OAuth 登录过程中的进度事件（含授权链接 / 设备码）。 */
export interface OAuthNotifyMessage {
  readonly type: string;
  readonly message?: string;
  readonly url?: string;
  readonly instructions?: string;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly links?: readonly { url: string; label?: string }[];
}

export interface OAuthLoginOutcome {
  readonly ok: boolean;
  readonly provider: string;
  readonly error?: string;
  readonly check?: { status: string; reason?: string; message?: string };
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

  /** session 用量统计：token、费用、上下文占用。 */
  getStats(workspace: string): Promise<SessionStatsData | null>;

  getModels(workspace: string): Promise<ModelPickerData | null>;
  setModel(workspace: string, provider: string, modelId: string): Promise<{ ok: boolean; error?: string }>;
  setThinkingLevel(workspace: string, level: string): Promise<{ ok: boolean; error?: string }>;

  trustState(workspace: string): Promise<TrustState>;
  decideTrust(workspace: string, decision: "always" | "never"): Promise<{ ok: boolean }>;

  listSessions(workspace: string): Promise<SessionSummary[]>;
  switchSession(workspace: string, sessionPath: string): Promise<{ ok: boolean; cancelled: boolean }>;
  deleteSession(workspace: string, sessionPath: string): Promise<{ ok: boolean; error?: string }>;
  newSession(workspace: string): Promise<{ ok: boolean; cancelled: boolean; error?: string }>;
  forkFromMessage(workspace: string, entryId: string): Promise<{ ok: boolean; cancelled: boolean; error?: string }>;
  getMessages(workspace: string): Promise<readonly Record<string, unknown>[]>;
  setSessionName(workspace: string, name: string): Promise<{ ok: boolean }>;

  searchPackages(query: string): Promise<MarketPackage[]>;
  listPackages(): Promise<string[]>;
  installPackage(spec: string, scope: "global" | "project", workspace: string): Promise<CliOutcome>;
  updatePackage(spec: string, scope: "global" | "project", workspace: string): Promise<CliOutcome>;
  removePackage(spec: string, scope: "global" | "project", workspace: string): Promise<CliOutcome>;

  /** 回复扩展的对话框（select/confirm/input/editor）。 */
  respondUi(
    workspace: string,
    requestId: string,
    response: Record<string, unknown>,
  ): Promise<{ ok: boolean }>;

  oauthLogin(provider: string): Promise<OAuthLoginOutcome>;
  oauthCancel(): void;
  respondOAuthPrompt(id: string, value: string | null): void;
  onOAuthPrompt(listener: (message: OAuthPromptMessage) => void): () => void;
  onOAuthNotify(listener: (message: OAuthNotifyMessage) => void): () => void;

  listCredentials(): Promise<CredentialInfo[]>;
  /** API Key 登录：选格式（openai/anthropic 兼容）+ 网址 + key。 */
  setApiCredential(format: "openai" | "anthropic", baseUrl: string, key: string): Promise<AuthSetOutcome>;
  removeCredential(provider: string): Promise<boolean>;
}