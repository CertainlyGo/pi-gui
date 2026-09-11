import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type {
  EngineEventPayload,
  MarketPackage,
  ModelPickerData,
  OAuthPromptMessage,
  SessionStatsData,
  SessionSummary,
} from "../../shared/ipc-contract.ts";
import { parseUnifiedDiff } from "./diff.ts";
import type { ParsedDiff } from "./diff.ts";
import { mapMessagesToItems } from "./history.ts";

type ItemKind = "user" | "assistant" | "tool" | "bash" | "system";

interface Item {
  readonly kind: ItemKind;
  readonly id: string;
  title?: string;
  state?: string;
  text: string;
  /** 工具调用的参数（美化后的 JSON），展开时展示。 */
  args?: string;
  /** 工具执行的输出（累计），展开时展示。 */
  output?: string;
  /** edit 工具返回的 unified diff 文本。 */
  diff?: string;
  /** 用户消息的条目 id（fork 用）。 */
  entryId?: string;
}

interface StatsState {
  input: number;
  output: number;
  cacheHitPct: number | null;
  ctxTokens: number | null;
  ctxWindow: number | null;
  cost: number;
}

const ZERO_STATS: StatsState = {
  input: 0,
  output: 0,
  cacheHitPct: null,
  ctxTokens: null,
  ctxWindow: null,
  cost: 0,
};

/** 扩展要的对话框（Extension UI Protocol）。 */
interface UiDialog {
  readonly id: string;
  readonly method: string;
  readonly title: string;
  readonly message?: string;
  readonly placeholder?: string;
  readonly prefill?: string;
  readonly options?: readonly string[];
}

const OAUTH_PROVIDERS: readonly { id: string; label: string }[] = [
  { id: "openai-codex", label: "OpenAI Codex（ChatGPT 订阅）" },
  { id: "anthropic", label: "Claude Pro / Max" },
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "xai", label: "xAI（Grok / X Premium）" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "kimi-coding", label: "Kimi Coding" },
  { id: "radius", label: "Radius（pi 网关）" },
];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readObj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** 参数序列化成可读 JSON（失败时退回原文）。 */
function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value) as unknown, null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 从工具执行结果的 { content: [{type:"text",text}] } 里抽出纯文本。 */
function toolResultText(value: unknown): string | undefined {
  const result = readObj(value);
  if (typeof result["text"] === "string" && result["text"].length > 0) return result["text"];
  const content = result["content"];
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    const entry = readObj(part);
    if (typeof entry["text"] === "string" && entry["text"].length > 0) parts.push(entry["text"]);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

const LEVEL_LABELS: Record<string, string> = {
  off: "关",
  minimal: "极简",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

export function App(): JSX.Element {
  const [view, setView] = useState<"chat" | "market">("chat");
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [stats, setStats] = useState<StatsState>(ZERO_STATS);
  const [streamSpeed, setStreamSpeed] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [accountOpen, setAccountOpen] = useState(false);
  const [trust, setTrust] = useState<{ resources: readonly string[]; decided: boolean } | null>(null);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [dialog, setDialog] = useState<UiDialog | null>(null);
  const [currentSession, setCurrentSession] = useState<{
    id: string;
    name: string;
    file: string | null;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const autoNamedRef = useRef<string | null>(null);

  const itemsRef = useRef<Item[]>([]);
  const itemIdsRef = useRef<string[]>([]);
  const [, setTick] = useState(0);
  const busyRef = useRef(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);
  const currentAssistantId = useRef<string | null>(null);
  const speedSamples = useRef<Array<{ t: number; output: number }>>([]);

  function rerender(): void {
    setTick((tick) => tick + 1);
  }

  function pushItem(item: Item): void {
    itemsRef.current.push(item);
    itemIdsRef.current.push(item.id);
    rerender();
  }

  function toggleExpanded(id: string): void {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function patchOrCreateItem(
    id: string,
    patch: {
      kind: ItemKind;
      title?: string;
      state?: string;
      text?: string;
      args?: string;
      output?: string;
      diff?: string;
    },
  ): void {
    const index = itemIdsRef.current.indexOf(id);
    if (index === -1) {
      pushItem({
        kind: patch.kind,
        id,
        text: patch.text ?? "",
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.args !== undefined ? { args: patch.args } : {}),
        ...(patch.output !== undefined ? { output: patch.output } : {}),
        ...(patch.diff !== undefined ? { diff: patch.diff } : {}),
      });
      return;
    }
    const existing = itemsRef.current[index]!;
    itemsRef.current[index] = {
      ...existing,
      ...patch,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.args !== undefined ? { args: patch.args } : {}),
      ...(patch.output !== undefined ? { output: patch.output } : {}),
      ...(patch.diff !== undefined ? { diff: patch.diff } : {}),
    };
    rerender();
  }

  function upsertStreamingText(id: string, text: string): void {
    const index = itemIdsRef.current.indexOf(id);
    if (index === -1) {
      pushItem({ kind: "assistant", id, text });
      return;
    }
    itemsRef.current[index] = { ...itemsRef.current[index]!, text };
    rerender();
  }

  function refreshSessions(path: string): void {
    void window.piGui.listSessions(path).then(setSessions);
  }

  async function syncCurrentSession(path: string): Promise<void> {
    try {
      const state = await window.piGui.getState(path);
      const data = asRecord(state["data"]);
      const file = str(data["sessionFile"]);
      const id = str(data["sessionId"]) ?? "";
      const name = str(data["sessionName"]);
      setCurrentSession({
        id,
        name: name ?? (id.length === 0 ? "新会话" : id.slice(0, 8)),
        file: file ?? null,
      });
    } catch {
      // 引擎刚启动可能还没有会话元数据，保持现状即可。
    }
  }

  /** 恢复最近会话并载入它的历史消息（重开窗口后消息仍在）。 */
  async function loadHistory(path: string): Promise<void> {
    const history = await window.piGui.listSessions(path);
    if (history.length > 0) {
      const resumed = await window.piGui.switchSession(path, history[0]!.path);
      if (resumed.ok && !resumed.cancelled) {
        pushItem({
          kind: "system",
          id: `resume-${Date.now()}`,
          text: `已恢复最近会话：${history[0]!.name}`,
        });
      }
    }
    const messages = await window.piGui.getMessages(path);
    itemsRef.current = mapMessagesToItems(messages);
    itemIdsRef.current = itemsRef.current.map((item) => item.id);
    currentAssistantId.current = null;
    await syncCurrentSession(path);
    streamEndRef.current?.scrollIntoView({ block: "end" });
    rerender();
  }

  async function startEngine(path: string): Promise<void> {
    try {
      const snapshot = await window.piGui.startEngine(path);
      setStatus(snapshot.status);
      pushItem({
        kind: "system",
        id: `open-${Date.now()}`,
        text: `引擎已启动（pid ${snapshot.pid ?? "?"}）`,
      });
      refreshSessions(path);
      await loadHistory(path);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openWorkspace(): Promise<void> {
    setStartError(null);
    const path = await window.piGui.openWorkspace();
    if (path === null) return;
    setWorkspace(path);
    setTrust(null);
    const trustState = await window.piGui.trustState(path);
    setTrust({ resources: trustState.resources, decided: trustState.decided });
    if (trustState.decided) {
      await startEngine(path);
    }
  }

  async function decideTrust(decision: "always" | "never"): Promise<void> {
    if (workspace === null) return;
    await window.piGui.decideTrust(workspace, decision);
    setTrust((state) => (state === null ? null : { ...state, decided: true }));
    await startEngine(workspace);
  }

  async function switchToSession(summary: SessionSummary): Promise<void> {
    if (workspace === null) return;
    if (status !== "ready") {
      pushItem({ kind: "system", id: `switch-${Date.now()}`, text: `引擎未就绪，无法切换会话` });
      return;
    }
    const result = await window.piGui.switchSession(workspace, summary.path);
    if (!result.ok) {
      pushItem({ kind: "system", id: `switch-${Date.now()}`, text: "会话切换失败" });
      return;
    }
    pushItem({
      kind: "system",
      id: `switch-${Date.now()}`,
      text: result.cancelled ? "会话切换被扩展取消" : `已切换到会话：${summary.name}`,
    });
    if (result.cancelled) return;
    const messages = await window.piGui.getMessages(workspace);
    itemsRef.current = mapMessagesToItems(messages);
    itemIdsRef.current = itemsRef.current.map((item) => item.id);
    currentAssistantId.current = null;
    await syncCurrentSession(workspace);
    rerender();
  }

  async function createNewSession(): Promise<void> {
    if (workspace === null) return;
    if (status !== "ready") {
      pushItem({
        kind: "system",
        id: `new-${Date.now()}`,
        text: "引擎未就绪，无法新建会话（先选择工作区）",
      });
      return;
    }
    const result = await window.piGui.newSession(workspace);
    if (!result.ok) {
      pushItem({ kind: "system", id: `new-${Date.now()}`, text: `新建会话失败：${result.error ?? "?"}` });
      return;
    }
    if (result.cancelled) {
      pushItem({ kind: "system", id: `new-${Date.now()}`, text: "新建会话被扩展取消" });
      return;
    }
    itemsRef.current = [];
    itemIdsRef.current = [];
    currentAssistantId.current = null;
    await syncCurrentSession(workspace);
    refreshSessions(workspace);
    pushItem({ kind: "system", id: `fresh-${Date.now()}`, text: "已新建会话" });
    rerender();
  }

  async function deleteSessionFlow(summary: SessionSummary): Promise<void> {
    if (workspace === null) return;
    if (pendingDelete !== summary.path) {
      setPendingDelete(summary.path);
      return;
    }
    setPendingDelete(null);
    const result = await window.piGui.deleteSession(workspace, summary.path);
    pushItem({
      kind: "system",
      id: `del-${Date.now()}`,
      text: result.ok
        ? `已删除会话：${summary.name}`
        : `删除失败：${result.error ?? "?"}`,
    });
    refreshSessions(workspace);
  }

  async function forkFrom(entryId: string): Promise<void> {
    if (workspace === null) return;
    const result = await window.piGui.forkFromMessage(workspace, entryId);
    if (!result.ok) {
      pushItem({ kind: "system", id: `fork-${Date.now()}`, text: `分叉失败：${result.error ?? "?"}` });
      return;
    }
    if (result.cancelled) {
      pushItem({ kind: "system", id: `fork-${Date.now()}`, text: "分叉被扩展取消" });
      return;
    }
    const messages = await window.piGui.getMessages(workspace);
    itemsRef.current = mapMessagesToItems(messages);
    itemIdsRef.current = itemsRef.current.map((item) => item.id);
    currentAssistantId.current = null;
    await syncCurrentSession(workspace);
    refreshSessions(workspace);
    pushItem({ kind: "system", id: `forked-${Date.now()}`, text: "已进入子会话（从此条消息分叉）" });
    rerender();
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (workspace === null || text.length === 0) return;
    setInput("");
    const isFirstMessage = itemsRef.current.length === 0;
    pushItem({ kind: "user", id: `user-${Date.now()}`, text });
    const behavior = busyRef.current ? "steer" : undefined;
    await window.piGui.prompt(workspace, text, behavior);
    // 新会话用第一条问题命名（有历史消息的会话不重命名）
    if (
      isFirstMessage &&
      currentSession !== null &&
      autoNamedRef.current !== currentSession.id
    ) {
      autoNamedRef.current = currentSession.id;
      const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
      const name = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
      const named = await window.piGui.setSessionName(workspace, name);
      if (named.ok) {
        await syncCurrentSession(workspace);
        refreshSessions(workspace);
      }
    }
    streamEndRef.current?.scrollIntoView({ block: "end" });
  }

  async function abort(): Promise<void> {
    if (workspace === null) return;
    await window.piGui.abort(workspace);
  }

  async function respondDialog(response: Record<string, unknown>): Promise<void> {
    if (workspace === null || dialog === null) return;
    await window.piGui.respondUi(workspace, dialog.id, response);
    setDialog(null);
  }

  useEffect(() => {
    let msgSeq = 0;
    const userIds = new Set<string>();

    function handleEvent(payload: EngineEventPayload): void {
      const record = asRecord(payload.message);
      const type = record["type"];

      if (type === "agent_start") {
        busyRef.current = true;
        setBusy(true);
        return;
      }
      if (type === "agent_settled" || type === "agent_end") {
        busyRef.current = false;
        setBusy(false);
        return;
      }
      if (type === "message_start") {
        const id = `msg-${++msgSeq}`;
        currentAssistantId.current = id;
        upsertStreamingText(id, "");
        return;
      }
      if (type === "message_update") {
        trackSpeed(record);
        markStreamActivity();
        const event = asRecord(record["assistantMessageEvent"]);
        const eventType = str(event["type"]);
        const id = currentAssistantId.current ?? `msg-${++msgSeq}`;
        if (currentAssistantId.current === null) currentAssistantId.current = id;

        if (eventType === "text_delta" || eventType === "thinking_delta") {
          const delta = str(event["delta"]) ?? "";
          const index = itemIdsRef.current.indexOf(id);
          const current = index === -1 ? undefined : itemsRef.current[index];
          upsertStreamingText(id, (current?.text ?? "") + delta);
          return;
        }
        if (eventType === "toolcall_start") {
          const toolId = str(event["id"]) ?? `tool-${++msgSeq}`;
          currentAssistantId.current = null;
          const toolName = str(event["toolName"]) ?? "工具";
          patchOrCreateItem(toolId, { kind: "tool", title: toolName, state: "开始" });
          return;
        }
        if (eventType === "toolcall_end") {
          const toolCall = asRecord(event["toolCall"]);
          const toolId = str(event["id"]) ?? str(toolCall["id"]);
          if (toolId !== undefined) {
            patchOrCreateItem(toolId, { kind: "tool", state: "完成" });
          }
          return;
        }
        return;
      }
      if (type === "tool_execution_start") {
        // toolCallId 与 toolcall_start 的 id 相同，两类事件会合并成同一张卡片。
        const id = str(record["toolCallId"]) ?? `tool-${++msgSeq}`;
        const title = str(record["toolName"]) ?? "工具";
        const args = readObj(record["args"]);
        patchOrCreateItem(id, {
          kind: "tool",
          title,
          state: "运行中",
          ...(Object.keys(args).length > 0 ? { args: prettyJson(args) } : {}),
        });
        return;
      }
      if (type === "tool_execution_update") {
        const id = str(record["toolCallId"]) ?? `tool-${++msgSeq}`;
        const title = str(record["toolName"]) ?? "工具";
        const output = toolResultText(record["partialResult"]);
        patchOrCreateItem(id, {
          kind: "tool",
          title,
          state: "运行中",
          ...(output !== undefined ? { output } : {}),
        });
        return;
      }
      if (type === "tool_execution_end") {
        const id = str(record["toolCallId"]) ?? `tool-${++msgSeq}`;
        const title = str(record["toolName"]) ?? "工具";
        const output = toolResultText(record["result"]);
        const isError = record["isError"] === true;
        const resultDetails = readObj(readObj(record["result"])["details"]);
        const diff = str(resultDetails["diff"]) ?? str(resultDetails["patch"]);
        patchOrCreateItem(id, {
          kind: "tool",
          title,
          state: isError ? "失败" : "完成",
          ...(output !== undefined ? { output } : {}),
          ...(diff !== undefined ? { diff } : {}),
        });
        return;
      }
      if (type === "bash_execution_update") {
        const id = str(record["id"]) ?? `bash-${++msgSeq}`;
        const delta = str(record["delta"]) ?? "";
        const index = itemIdsRef.current.indexOf(id);
        const current = index === -1 ? undefined : itemsRef.current[index];
        patchOrCreateItem(id, {
          kind: "bash",
          title: str(record["command"]) ?? "shell",
          state: "运行中",
          output: (current?.output ?? "") + delta,
        });
        return;
      }
      if (type === "user_message") {
        const id = str(record["id"]) ?? `user-${++msgSeq}`;
        if (userIds.has(id)) return;
        userIds.add(id);
        const text = str(record["message"]) ?? "";
        pushItem({ kind: "user", id, text });
        return;
      }
      if (type === "extension_error") {
        const message = str(record["message"]) ?? str(record["error"]) ?? "扩展出错";
        pushItem({ kind: "system", id: `err-${++msgSeq}`, text: message });
      }
    }

    function trackSpeed(record: Record<string, unknown>): void {
      const usage = asRecord(record["usage"]);
      const output = num(usage["output"]);
      if (output <= 0) return;
      const now = Date.now();
      const samples = speedSamples.current;
      samples.push({ t: now, output });
      while (samples.length > 1 && now - samples[0]!.t > 8_000) samples.shift();
      if (samples.length >= 2 && samples[0]!.output < output) {
        const elapsedSec = (now - samples[0]!.t) / 1000;
        if (elapsedSec >= 0.4) {
          setStreamSpeed((output - samples[0]!.output) / elapsedSec);
        }
      }
    }

    function markStreamActivity(): void {
      busyRef.current = true;
      setBusy(true);
    }

    const offEvents = window.piGui.onEngineEvent(handleEvent);
    const offStatus = window.piGui.onStatus((payload) => setStatus(payload.status));
    const offWarnings = window.piGui.onWarning((payload) =>
      pushItem({ kind: "system", id: `warn-${Date.now()}`, text: payload.message }),
    );
    const offUi = window.piGui.onUiRequest((payload) => {
      const request = payload.request;
      const method = request.method;
      const title = str(request["title"]) ?? str(request["message"]) ?? "扩展请求";
      const fireAndForget = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"];
      if (fireAndForget.includes(method)) {
        pushItem({
          kind: "system",
          id: `ui-${++msgSeq}`,
          text: `扩展提示（${method}）：${title}`,
        });
        return;
      }
      setDialog({
        id: request.id,
        method,
        title,
        ...(str(request["message"]) !== undefined ? { message: str(request["message"])! } : {}),
        ...(str(request["placeholder"]) !== undefined ? { placeholder: str(request["placeholder"])! } : {}),
        ...(str(request["prefill"]) !== undefined ? { prefill: str(request["prefill"])! } : {}),
        ...(Array.isArray(request["options"]) ? { options: request["options"].map(String) } : {}),
      });
    });

    return () => {
      offEvents();
      offStatus();
      offWarnings();
      offUi();
    };
  }, []);

  useEffect(() => {
    if (workspace === null) return;
    const ws = workspace; // 嵌套函数里 TS 不做收窄
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function refresh(): Promise<void> {
      const data = await window.piGui.getStats(ws);
      if (cancelled) return;
      setStats(toStats(data));
    }
    void refresh();
    timer = setInterval(() => void refresh(), 2500);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [workspace]);

  const items = itemsRef.current;

  return (
    <div className="app">
      <header className="topbar">
        <nav className="view-tabs">
          <button className={`tab ${view === "chat" ? "on" : ""}`} onClick={() => setView("chat")}>
            会话
          </button>
          <button className={`tab ${view === "market" ? "on" : ""}`} onClick={() => setView("market")}>
            插件市场
          </button>
        </nav>
        {view === "chat" && <div className="ws-name">{workspace ?? "未选择工作区"}</div>}
        {view === "chat" && (
          <div className={`engine-state ${status}`}>
            <span className="dot" />
            {status}
          </div>
        )}
        <div className="spacer" />
        <ModelPicker
          workspace={workspace}
          onAskConfigure={() => setAccountOpen(true)}
        />
        <AccountButton
          open={accountOpen}
          onOpen={() => setAccountOpen(true)}
          onClose={() => setAccountOpen(false)}
          onChanged={() => rerender()}
        />
        {view === "chat" && (
          <button
            className="btn ghost"
            onClick={() => void openWorkspace()}
            disabled={busy}
          >
            {workspace === null ? "选择工作区" : "更换工作区"}
          </button>
        )}
      </header>

      {view === "chat" ? (
        <>
          <div className="chat-body">
            <aside
              className="rail"
              onClick={() => setPendingDelete(null)}
            >
              <button
                className="newbtn"
                onClick={(event) => {
                  event.stopPropagation();
                  void createNewSession();
                }}
                disabled={workspace === null}
              >
                ＋ 新建会话
              </button>
              {workspace === null && <p className="rail-empty">选择工作区后显示会话列表。</p>}
              {currentSession !== null && (
                <div className="sess current" title="当前会话">
                  <span className="sess-name">{currentSession.name}</span>
                  <span className="sess-badge">当前</span>
                </div>
              )}
              {groupSessions(sessions)
                .filter((group) =>
                  group.items.some(
                    (item) =>
                      currentSession === null ||
                      item.path !== currentSession.file,
                  ),
                )
                .map((group) => (
                  <div key={group.label}>
                    <div className="grouplabel">{group.label}</div>
                    {group.items.map((summary) => {
                      const isCurrent = currentSession !== null && summary.path === currentSession.file;
                      if (isCurrent) return null;
                      return (
                        <div key={summary.path} className="sess-row">
                          <button
                            type="button"
                            className="sess"
                            onClick={() => void switchToSession(summary)}
                            title={`恢复到 ${summary.path}`}
                          >
                            <span className="sess-name">{summary.name}</span>
                            <span className="sess-time">{formatTime(summary.updatedAt)}</span>
                          </button>
                          <button
                            type="button"
                            className={`sess-del ${pendingDelete === summary.path ? "arm" : ""}`}
                            title={pendingDelete === summary.path ? "再点一次确认删除" : "删除此会话"}
                            onClick={(event) => {
                              event.stopPropagation();
                              void deleteSessionFlow(summary);
                            }}
                          >
                            {pendingDelete === summary.path ? "确认" : "🗑"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
            </aside>
            <main className="stream">
              {trust !== null && !trust.decided && trust.resources.length > 0 && (
                <div className="trust-banner">
                  <h3>此目录包含需要信任的项目资源</h3>
                  <ul>
                    {trust.resources.map((resource) => (
                      <li key={resource}>
                        <code>{resource}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="small">
                    信任后 pi 才会加载这些项目级设置、扩展与技能。资源以你的身份运行代码，
                    不信任则全部忽略。此决定按目录记录在 pi 的
                    <code> trust.json</code>，可在终端里同样生效。
                  </p>
                  <div className="acts">
                    <button className="btn warn" onClick={() => void decideTrust("always")}>
                      信任并加载
                    </button>
                    <button className="btn ghost" onClick={() => void decideTrust("never")}>
                      不信任这个目录
                    </button>
                  </div>
                </div>
              )}
              {startError !== null && (
                <div className="start-error">
                  <strong>引擎启动失败</strong>
                  <pre>{startError}</pre>
                </div>
              )}
              {items.length === 0 && workspace === null && (
                <p className="empty">先选一个工作区（本地目录），agent 会在里面干活。</p>
              )}
              {items.length === 0 && workspace !== null && status !== "ready" && trust?.decided !== false && (
                <p className="empty">引擎启动中…</p>
              )}
              {trust !== null && !trust.decided && (
                <p className="empty trust-pending">先决定是否信任这个目录，引擎才会启动。</p>
              )}
              <div className="wrap" key={currentSession?.id ?? "fresh"}>
                {items.map((item) => (
                  <ItemView
                    key={item.id}
                    item={item}
                    expanded={expandedIds.has(item.id)}
                    onToggle={() => toggleExpanded(item.id)}
                    onFork={
                      item.kind === "user" && item.entryId !== undefined && workspace !== null
                        ? () => void forkFrom(item.entryId!)
                        : undefined
                    }
                  />
                ))}
              </div>
              <div ref={streamEndRef} />
            </main>
          </div>

          <StatsBar stats={stats} busy={busy} speed={streamSpeed} />

          <footer className="composer">
            <div className="composer-inner">
              <textarea
                rows={1}
                placeholder={
                  workspace === null
                    ? "先选择工作区"
                    : busy
                      ? "补充说明（agent 完成当前动作后处理）"
                      : "说点什么…"
                }
                value={input}
                disabled={workspace === null}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-foot">
                <span className="hint">
                  {workspace === null ? "尚未连接引擎" : "Enter 发送 · Shift+Enter 换行"}
                </span>
                {busy ? (
                  <button className="btn warn" onClick={() => void abort()}>
                    停止
                  </button>
                ) : (
                  <button
                    className="btn primary"
                    onClick={() => void send()}
                    disabled={workspace === null || input.trim().length === 0}
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </footer>
        </>
      ) : (
        <MarketView workspace={workspace} />
      )}

      {dialog !== null && (
        <ExtensionDialog
          dialog={dialog}
          onRespond={(response) => void respondDialog(response)}
        />
      )}
    </div>
  );
}

function formatTime(millis: number): string {
  const date = new Date(millis);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()}`;
}

function groupSessions(
  sessions: readonly SessionSummary[],
): { label: string; items: readonly SessionSummary[] }[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const groups: { label: string; items: SessionSummary[] }[] = [];
  for (const summary of sessions) {
    const label =
      summary.updatedAt >= startOfToday
        ? "今天"
        : summary.updatedAt >= startOfYesterday
          ? "昨天"
          : "更早";
    let group = groups.find((entry) => entry.label === label);
    if (group === undefined) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push(summary);
  }
  return groups;
}

function toStats(data: SessionStatsData | null): StatsState {
  if (data === null) return ZERO_STATS;
  const tokens = asRecord(data["tokens"]);
  const input = num(tokens["input"]);
  const output = num(tokens["output"]);
  const cacheRead = num(tokens["cacheRead"]);
  const cacheHitPct = input + cacheRead > 0 ? (cacheRead / (input + cacheRead)) * 100 : null;
  const context = asRecord(data["contextUsage"]);
  const ctxTokens = typeof context["tokens"] === "number" ? context["tokens"] : null;
  const ctxWindow = num(context["contextWindow"]);
  return {
    input,
    output,
    cacheHitPct,
    ctxTokens,
    ctxWindow: ctxWindow > 0 ? ctxWindow : null,
    cost: num(data["cost"]),
  };
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function StatsBar({
  stats,
  busy,
  speed,
}: {
  stats: StatsState;
  busy: boolean;
  speed: number | null;
}): JSX.Element {
  const ctxPct =
    stats.ctxTokens !== null && stats.ctxWindow !== null
      ? Math.min(100, (stats.ctxTokens / stats.ctxWindow) * 100)
      : null;
  return (
    <div className="statsbar">
      <span className="stat">
        输入 <b>{formatCount(stats.input)}</b>
      </span>
      <span className="stat">
        输出 <b>{formatCount(stats.output)}</b>
      </span>
      <span className="stat">
        缓存命中 <b>{formatPercent(stats.cacheHitPct)}</b>
      </span>
      <span className="stat ctx">上下文</span>
      <div
        className="ctx-track"
        title={
          stats.ctxTokens === null ? "上下文不可用" : `${stats.ctxTokens} / ${stats.ctxWindow}`
        }
      >
        <div className="ctx-fill" style={ctxPct === null ? {} : { width: `${ctxPct}%` }} />
      </div>
      <span className="stat ctx-num">
        {stats.ctxTokens !== null
          ? `${formatCount(stats.ctxTokens)}/${formatCount(stats.ctxWindow ?? 0)}`
          : "—"}
      </span>
      <span className={`stat speed ${busy ? "" : "dim"}`}>
        速度 {speed !== null && speed > 0 ? `${speed.toFixed(1)} tok/s` : "—"}
      </span>
      {stats.cost > 0 && <span className="stat cost">费用 ${stats.cost.toFixed(2)}</span>}
    </div>
  );
}

/**
 * 模型选择器：按供应商分组列出可用模型，供应商是选择维度；
 * 未配置凭据的组给出去账号页的引导（Round 5 的修改项）。
 */
function ModelPicker({
  workspace,
  onAskConfigure,
}: {
  workspace: string | null;
  onAskConfigure: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ModelPickerData | null>(null);
  const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [hintProvider, setHintProvider] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (!next || workspace === null) return;
    setError(null);
    setHintProvider(null);
    try {
      const [models, credentials] = await Promise.all([
        window.piGui.getModels(workspace),
        window.piGui.listCredentials(),
      ]);
      setData(models);
      setConfigured(new Set(credentials.map((entry) => entry.provider)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function refreshCurrent(): Promise<void> {
    if (workspace === null) return;
    try {
      setData(await window.piGui.getModels(workspace));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function selectModel(model: { id: string; provider: string }): Promise<void> {
    if (workspace === null) return;
    const result = await window.piGui.setModel(workspace, model.provider, model.id);
    if (!result.ok) {
      setError(result.error ?? "设置失败");
      return;
    }
    setHintProvider(configured.has(model.provider) ? null : model.provider);
    await refreshCurrent();
  }

  async function selectThinking(level: string): Promise<void> {
    if (workspace === null) return;
    const result = await window.piGui.setThinkingLevel(workspace, level);
    if (!result.ok) {
      setError(result.error ?? "设置失败");
      return;
    }
    await refreshCurrent();
  }

  const models = data?.models ?? [];
  const current = data?.current;
  const currentModel = current?.modelId === undefined ? undefined : current;
  const currentName =
    currentModel === undefined
      ? undefined
      : (models.find((model) => model.id === currentModel.modelId)?.name ?? currentModel.modelId);
  const pillLabel =
    currentModel === undefined
      ? "选择模型"
      : `${currentModel.provider ?? "?"} · ${currentName ?? currentModel.modelId}`;

  const byProvider = new Map<string, Array<{ id: string; name: string; provider: string }>>();
  for (const model of models) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  const groups = [...byProvider.entries()].sort(
    (a, b) => Number(configured.has(b[0])) - Number(configured.has(a[0])),
  );

  return (
    <div className="model-wrap">
      <button
        className="pill"
        onClick={() => void toggle()}
        disabled={workspace === null}
        title={workspace === null ? "先选择工作区" : "切换模型 / 供应商 / 思考等级"}
      >
        {pillLabel} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="model-popover">
          {error !== null && <p className="model-error">{error}</p>}
          {hintProvider !== null && (
            <div className="model-hint">
              <span>
                <code>{hintProvider}</code> 未配置凭据，发消息会被引擎拒绝。
              </span>
              <button className="btn primary small" onClick={() => { setOpen(false); onAskConfigure(); }}>
                到账号页配置
              </button>
            </div>
          )}
          {data === null && <p className="model-empty">加载模型清单…</p>}
          {groups.length === 0 && data !== null && (
            <p className="model-empty">没有可用模型（先到账号页配置凭据？）</p>
          )}
          {groups.map(([provider, providerModels]) => (
            <div key={provider} className="model-group">
              <div className="model-group-head">
                <span className="model-provider">{provider}</span>
                <span className={`provider-badge ${configured.has(provider) ? "on" : ""}`}>
                  {configured.has(provider) ? "已配置" : "未配置凭据"}
                </span>
              </div>
              {providerModels.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className={`model-row ${current?.modelId === model.id ? "on" : ""}`}
                  onClick={() => void selectModel(model)}
                >
                  <span className="model-name">{model.name}</span>
                  <span className="model-id">{model.id}</span>
                </button>
              ))}
            </div>
          ))}
          {data !== null && data.thinkingLevels.length > 0 && (
            <div className="model-group thinking">
              <div className="model-group-head">思考等级</div>
              <div className="level-row">
                {data.thinkingLevels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    className={`level-btn ${current?.thinkingLevel === level ? "on" : ""}`}
                    onClick={() => void selectThinking(level)}
                  >
                    {LEVEL_LABELS[level] ?? level}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AccountButton({
  open,
  onOpen,
  onClose,
  onChanged,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [providers, setProviders] = useState<
    Array<{ provider: string; type: string; keyMasked: string }>
  >([]);
  const [apiFormat, setApiFormat] = useState<"openai" | "anthropic">("openai");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiSaving, setApiSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const [oauthBusy, setOauthBusy] = useState<string | null>(null);
  const [oauthStatus, setOauthStatus] = useState<string | null>(null);
  const [oauthPrompt, setOauthPrompt] = useState<OAuthPromptMessage | null>(null);
  const [oauthText, setOauthText] = useState("");

  function refreshList(): void {
    void window.piGui.listCredentials().then(setProviders);
  }

  useEffect(() => {
    if (open) refreshList();
  }, [open]);

  useEffect(() => {
    const offPrompt = window.piGui.onOAuthPrompt((message) => {
      setOauthPrompt(message);
      setOauthText("");
    });
    const offNotify = window.piGui.onOAuthNotify((message) => {
      if (message.type === "progress") {
        setOauthStatus(message.message ?? "授权中…");
      } else if (message.type === "info") {
        setOauthStatus(message.message ?? "等待授权…");
      } else if (message.type === "auth_url") {
        setOauthStatus("已在浏览器中打开授权页，完成后回到这里。");
      } else if (message.type === "device_code") {
        setOauthStatus(
          `在 ${message.verificationUri ?? "设备码页面"} 输入代码 ${message.userCode ?? ""}`,
        );
      }
    });
    return () => {
      offPrompt();
      offNotify();
    };
  }, []);

  async function saveApi(): Promise<void> {
    if (apiBaseUrl.trim().length === 0 || apiKey.trim().length === 0) return;
    setApiSaving(true);
    setOutcome(null);
    const result = await window.piGui.setApiCredential(apiFormat, apiBaseUrl.trim(), apiKey.trim());
    setApiSaving(false);
    if (!result.ok) {
      setOutcome({ ok: false, text: result.error ?? "保存失败" });
      return;
    }
    const check = result.check;
    if (check === undefined) {
      setOutcome({ ok: true, text: "已保存（未验证）" });
    } else if (check.status === "ready") {
      setOutcome({ ok: true, text: `已保存，${apiFormat === "openai" ? "OpenAI 兼容" : "Anthropic 兼容"} 端点就绪` });
    } else {
      const detail = check.reason ?? check.message ?? "凭据未被识别";
      setOutcome({ ok: false, text: `已保存，但未就绪：${detail}` });
    }
    setApiKey("");
    refreshList();
    onChanged();
  }

  async function remove(providerName: string): Promise<void> {
    await window.piGui.removeCredential(providerName);
    refreshList();
    onChanged();
  }

  async function oauthLogin(providerId: string): Promise<void> {
    setOauthStatus("启动登录…");
    setOauthBusy(providerId);
    const result = await window.piGui.oauthLogin(providerId);
    setOauthBusy(null);
    if (result.ok) {
      if (result.check?.status === "ready") {
        setOauthStatus(`已登录并验证通过：${providerId}`);
      } else {
        setOauthStatus(
          `凭据已保存，但校验未通过：${result.check?.reason ?? result.check?.message ?? "未知"}`,
        );
      }
      refreshList();
      onChanged();
    } else {
      setOauthStatus(`登录失败：${result.error ?? "未知错误"}`);
    }
  }

  function respondOauthPrompt(value: string | null): void {
    if (oauthPrompt === null) return;
    window.piGui.respondOAuthPrompt(oauthPrompt.id, value);
    setOauthPrompt(null);
    setOauthText("");
  }

  return (
    <>
      <button className="btn ghost" onClick={open ? onClose : onOpen}>
        账号
      </button>
      {open && (
        <div className="sheet-mask" onClick={onClose}>
          <div className="sheet" onClick={(event) => event.stopPropagation()}>
            <h2>账号与凭据</h2>
            <p className="sheet-sub">
              凭据写入 <code>~/.pi/agent/auth.json</code>（pi 自己的格式），保存后用
              <code> pi auth check</code> 验证。订阅登录直接跑 pi 自己的 OAuth 流程。
            </p>

            <div className="oauth-section">
              <div className="oauth-head">订阅登录（OAuth）</div>
              <div className="oauth-grid">
                {OAUTH_PROVIDERS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="btn oauth-btn"
                    disabled={oauthBusy !== null}
                    onClick={() => void oauthLogin(entry.id)}
                  >
                    {entry.label}
                    {oauthBusy === entry.id && "（登录中…）"}
                  </button>
                ))}
              </div>
              {oauthBusy !== null && (
                <button className="btn ghost small" onClick={() => window.piGui.oauthCancel()}>
                  取消登录
                </button>
              )}
              {oauthStatus !== null && <p className="cred-outcome">{oauthStatus}</p>}
            </div>

            <div className="oauth-divider" />

            <div className="cred-list">
              {providers.length === 0 && <p className="cred-empty">还没有配置任何 provider。</p>}
              {providers.map((entry) => (
                <div key={entry.provider} className="cred-row">
                  <code>{entry.provider}</code>
                  <span className="cred-type">{entry.type}</span>
                  <span className="cred-key">{entry.keyMasked}</span>
                  <button className="btn ghost small" onClick={() => void remove(entry.provider)}>
                    移除
                  </button>
                </div>
              ))}
            </div>

            <div className="api-login">
              <div className="api-head">API Key（自定义网关 / 兼容接口）</div>
              <div className="fmt-cards">
                <button
                  type="button"
                  className={`fmt-card ${apiFormat === "openai" ? "on" : ""}`}
                  onClick={() => setApiFormat("openai")}
                >
                  <span className="fmt-name">OpenAI 兼容</span>
                  <span className="fmt-desc">OpenAI、DeepSeek 及各类 /v1 网关</span>
                </button>
                <button
                  type="button"
                  className={`fmt-card ${apiFormat === "anthropic" ? "on" : ""}`}
                  onClick={() => setApiFormat("anthropic")}
                >
                  <span className="fmt-name">Anthropic 兼容</span>
                  <span className="fmt-desc">Claude 官方端点或兼容网关</span>
                </button>
              </div>
              <input
                placeholder={
                  apiFormat === "openai"
                    ? "API 网址（如 https://api.openai.com/v1）"
                    : "API 网址（如 https://api.anthropic.com）"
                }
                value={apiBaseUrl}
                onChange={(event) => setApiBaseUrl(event.target.value)}
              />
              <input
                type="password"
                placeholder="API Key"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <button
                className="btn primary full"
                onClick={() => void saveApi()}
                disabled={apiSaving || apiBaseUrl.trim().length === 0 || apiKey.trim().length === 0}
              >
                {apiSaving
                  ? "保存并验证…"
                  : `保存并验证（${apiFormat === "openai" ? "OpenAI 兼容" : "Anthropic 兼容"}）`}
              </button>
            </div>

            {outcome !== null && (
              <p className={`cred-outcome ${outcome.ok ? "ok" : "bad"}`}>{outcome.text}</p>
            )}

            <button className="btn ghost sheet-close" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      )}
      {oauthPrompt !== null && (
        <div className="sheet-mask" onClick={() => respondOauthPrompt(null)}>
          <div className="sheet" onClick={(event) => event.stopPropagation()}>
            <div className="ext-source">登录流程需要你确认</div>
            <h2>{oauthPrompt.message}</h2>
            {oauthPrompt.type === "select" && (oauthPrompt.options ?? []).length > 0 && (
              <div className="ext-options">
                {(oauthPrompt.options ?? []).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="btn opt-row"
                    onClick={() => respondOauthPrompt(option.id)}
                  >
                    <span>{option.label}</span>
                    {option.description !== undefined && (
                      <span className="opt-desc">{option.description}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {(oauthPrompt.type === "secret" ||
              oauthPrompt.type === "text" ||
              oauthPrompt.type === "manual_code") && (
              <>
                <input
                  autoFocus
                  type={oauthPrompt.type === "secret" ? "password" : "text"}
                  placeholder={oauthPrompt.placeholder ?? ""}
                  value={oauthText}
                  onChange={(event) => setOauthText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") respondOauthPrompt(oauthText);
                  }}
                />
                <div className="acts ext-acts">
                  <button
                    className="btn primary"
                    onClick={() => respondOauthPrompt(oauthText)}
                  >
                    发送
                  </button>
                </div>
              </>
            )}
            <button className="btn ghost sheet-close" onClick={() => respondOauthPrompt(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function MarketView({ workspace }: { workspace: string | null }): JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly MarketPackage[]>([]);
  const [installed, setInstalled] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<MarketPackage | null>(null);
  const [installScope, setInstallScope] = useState<"global" | "project">("global");
  const [installing, setInstalling] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    refreshInstalled();
    void search("");
  }, []);

  async function refreshInstalled(): Promise<void> {
    try {
      setInstalled(await window.piGui.listPackages());
    } catch {
      setInstalled([]);
    }
  }

  async function search(text: string): Promise<void> {
    setSearching(true);
    setMarketError(null);
    try {
      setResults(await window.piGui.searchPackages(text));
    } catch (caught) {
      setMarketError(caught instanceof Error ? caught.message : String(caught));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  async function doInstall(): Promise<void> {
    if (installTarget === null) return;
    setInstalling(true);
    setOutcome(null);
    const spec = `npm:${installTarget.name}`;
    const result = await window.piGui.installPackage(spec, installScope, workspace ?? ".");
    setInstalling(false);
    if (result.ok) {
      setOutcome({ ok: true, text: `已安装 ${installTarget.name}（${installScope === "project" ? "仅此工作区" : "全局"}）` });
      setInstallTarget(null);
      await refreshInstalled();
    } else {
      setOutcome({ ok: false, text: `安装失败：${result.error ?? "未知错误"}` });
    }
  }

  async function doAction(
    action: "update" | "remove",
    spec: string,
    scope: "global" | "project",
  ): Promise<void> {
    setOutcome(null);
    const workspaceArg = scope === "project" && workspace !== null ? workspace : ".";
    const result =
      action === "update"
        ? await window.piGui.updatePackage(spec, scope, workspaceArg)
        : await window.piGui.removePackage(spec, scope, workspaceArg);
    setOutcome(result.ok
      ? { ok: true, text: `${action === "update" ? "已更新" : "已移除"} ${spec}` }
      : { ok: false, text: `${action === "update" ? "更新" : "移除"}失败：${result.error ?? "未知错误"}` });
    await refreshInstalled();
  }

  return (
    <div className="market">
      <div className="mw">
        <div className="mhead">
          <div>
            <h2>插件市场</h2>
            <p className="sub">
              来自 npm 上带 <code>pi-package</code> 关键字的包。安装交给 pi 本体处理，
              我们只做浏览与按钮。
            </p>
          </div>
          <div className="installed-count">{installed.length} 个已安装</div>
        </div>

        <div className="market-search">
          <input
            placeholder="搜索插件…（如 vim、review、postgres）"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search(query);
            }}
          />
          <button className="btn primary" onClick={() => void search(query)} disabled={searching}>
            {searching ? "搜索中…" : "搜索"}
          </button>
        </div>

        {marketError !== null && <p className="market-error">{marketError}</p>}
        {outcome !== null && (
          <p className={`cred-outcome ${outcome.ok ? "ok" : "bad"}`}>{outcome.text}</p>
        )}

        <div className="installed-row">
          {installed.map((spec) => (
            <div key={spec} className="installed-chip">
              <code>{spec}</code>
              <button className="btn ghost small" onClick={() => void doAction("update", spec, "global")}>
                更新
              </button>
              <button className="btn ghost small" onClick={() => void doAction("remove", spec, "global")}>
                移除
              </button>
            </div>
          ))}
        </div>

        <div className="cards">
          {results.map((pkg) => (
            <div key={pkg.name} className="card">
              <div className="card-l1">
                <code className="card-name">{pkg.name}</code>
                <span className="card-by">{pkg.publisher}</span>
              </div>
              <p className="card-desc">{pkg.description || "（无描述）"}</p>
              <div className="card-stats">
                {pkg.downloadsLastWeek > 0
                  ? `周下载 ${formatCount(pkg.downloadsLastWeek)}`
                  : ""}
                {pkg.updatedAt !== "" ? ` · 更新于 ${pkg.updatedAt.slice(0, 10)}` : ""}
              </div>
              <div className="card-actions">
                <span className="card-ver">{pkg.version}</span>
                <button className="btn primary small" onClick={() => setInstallTarget(pkg)}>
                  安装
                </button>
              </div>
            </div>
          ))}
          {results.length === 0 && !searching && (
            <p className="card-none">没有结果。</p>
          )}
        </div>
      </div>

      {installTarget !== null && (
        <div className="sheet-mask" onClick={() => setInstallTarget(null)}>
          <div className="sheet" onClick={(event) => event.stopPropagation()}>
            <h2>安装 {installTarget.name}</h2>
            <p className="sheet-sub">
              版本 {installTarget.version}。扩展以你的身份运行代码 —— 安装前请确认你信任这个包。
            </p>
            <div className="scope">
              <label className={installScope === "global" ? "on" : ""}>
                <input
                  type="radio"
                  checked={installScope === "global"}
                  onChange={() => setInstallScope("global")}
                />
                <span>全局<span className="p"> → ~/.pi/agent/settings.json，所有工作区可用</span></span>
              </label>
              <label className={installScope === "project" ? "on" : ""}>
                <input
                  type="radio"
                  checked={installScope === "project"}
                  onChange={() => setInstallScope("project")}
                />
                <span>仅此工作区<span className="p"> → .pi/settings.json，可随仓库分享</span></span>
              </label>
            </div>
            <div className="acts">
              <button className="btn ghost" onClick={() => setInstallTarget(null)}>
                取消
              </button>
              <button className="btn primary" onClick={() => void doInstall()} disabled={installing}>
                {installing ? "安装中…" : "安装"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 扩展要的对话框。头部标明来源是第三方，防止非终端用户误以为这是 pi 官方在问。 */
function ExtensionDialog({
  dialog,
  onRespond,
}: {
  dialog: UiDialog;
  onRespond: (response: Record<string, unknown>) => void;
}): JSX.Element {
  const [text, setText] = useState(dialog.prefill ?? "");

  useEffect(() => {
    setText(dialog.prefill ?? "");
  }, [dialog.id, dialog.prefill]);

  return (
    <div className="sheet-mask">
      <div className="sheet ext-dialog">
        <div className="ext-source">来自第三方扩展（内容未经 pi 审核）</div>
        <h2>{dialog.title}</h2>
        {dialog.message !== undefined && <p className="sheet-sub">{dialog.message}</p>}
        <div className="ext-body">
          {dialog.method === "confirm" && (
            <div className="acts ext-acts">
              <button className="btn primary" onClick={() => onRespond({ confirmed: true })}>
                是
              </button>
              <button className="btn ghost" onClick={() => onRespond({ confirmed: false })}>
                否
              </button>
            </div>
          )}
          {dialog.method === "input" && (
            <>
              <input
                autoFocus
                placeholder={dialog.placeholder ?? ""}
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onRespond({ value: text });
                }}
              />
              <div className="acts ext-acts">
                <button className="btn primary" onClick={() => onRespond({ value: text })}>
                  发送
                </button>
              </div>
            </>
          )}
          {dialog.method === "editor" && (
            <>
              <textarea
                autoFocus
                rows={8}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <div className="acts ext-acts">
                <button className="btn primary" onClick={() => onRespond({ value: text })}>
                  发送
                </button>
              </div>
            </>
          )}
          {dialog.method === "select" && (
            <div className="ext-options">
              {(dialog.options ?? []).map((option) => (
                <button key={option} className="btn" onClick={() => onRespond({ value: option })}>
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="btn ghost sheet-close" onClick={() => onRespond({ cancelled: true })}>
          取消
        </button>
      </div>
    </div>
  );
}

function DiffView({ text }: { text: string }): JSX.Element {
  const parsed: ParsedDiff = parseUnifiedDiff(text);
  return (
    <div className="diffview">
      <div className="diff-summary">
        <span className="diff-num add">+{parsed.additions}</span>
        <span className="diff-num del">-{parsed.deletions}</span>
      </div>
      <div className="diff-rows">
        {parsed.rows.map((row, index) => (
          <div key={index} className={`diff-line ${row.kind}`}>
            <span className="diff-ln">{row.lineNumber === null ? "" : row.lineNumber}</span>
            <span className="diff-code">{row.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function writeContentOf(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    const content = parsed["content"];
    return typeof content === "string" ? content : argsJson;
  } catch {
    return argsJson;
  }
}

function ItemView({
  item,
  expanded,
  onToggle,
  onFork,
}: {
  item: Item;
  expanded: boolean;
  onToggle: () => void;
  onFork?: (() => void) | undefined;
}): JSX.Element {
  if (item.kind === "user") {
    return (
      <div className="me">
        <div className="who">你</div>
        <div className="me-text">{item.text}</div>
        {onFork !== undefined && (
          <button type="button" className="fork-btn" onClick={onFork}>
            ⟳ 从这里分支（进入子会话）
          </button>
        )}
      </div>
    );
  }
  if (item.kind === "assistant") {
    return <div className="bot-text">{item.text}</div>;
  }
  if (item.kind === "tool" || item.kind === "bash") {
    return (
      <div className="tool-card">
        <button
          type="button"
          className="tool-head"
          onClick={onToggle}
          title={expanded ? "收起" : "展开具体内容"}
        >
          <span className="tool-type">{item.kind === "bash" ? "shell" : "工具"}</span>
          <code>{item.title}</code>
          {item.state !== undefined && (
            <span className={`tool-state ${item.state === "失败" ? "bad" : ""}`}>{item.state}</span>
          )}
          <span className={`tool-caret ${expanded ? "open" : ""}`}>▾</span>
        </button>
        {expanded && (
          <div className="tool-details">
            {item.diff !== undefined && (
              <div className="tool-detail-block">
                <div className="tool-detail-label">变更</div>
                <DiffView text={item.diff} />
              </div>
            )}
            {item.kind === "tool" &&
              item.title?.toLowerCase().includes("write") &&
              item.args !== undefined && (
                <div className="tool-detail-block">
                  <div className="tool-detail-label">写入内容</div>
                  <pre className="tool-output">{writeContentOf(item.args)}</pre>
                </div>
              )}
            {item.args !== undefined && item.diff === undefined && item.kind !== "bash" && (
              <div className="tool-detail-block">
                <div className="tool-detail-label">参数</div>
                <pre className="tool-args">{item.args}</pre>
              </div>
            )}
            {item.output !== undefined && item.diff === undefined && (
              <div className="tool-detail-block">
                <div className="tool-detail-label">输出</div>
                <pre className="tool-output">{item.output}</pre>
              </div>
            )}
            {item.diff === undefined &&
              item.args === undefined &&
              item.output === undefined && (
                <div className="tool-detail-empty">（没有更多信息）</div>
              )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="system-note">
      <span className="sys-label">系统</span>
      <span>{item.text}</span>
    </div>
  );
}