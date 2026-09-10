import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { EngineEventPayload, ModelPickerData, SessionStatsData } from "../../shared/ipc-contract.ts";

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

const PROVIDER_DATALIST = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "xai",
  "deepseek",
  "together",
  "qwen-token-plan",
  "radius",
] as const;

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

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function readObj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
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

/**
 * 会话页：打开工作区 → 启动引擎 → 发 prompt → 事件流渲染。
 * 底部是 token/上下文/缓存/速度统计条；右上角账号页管凭据（写 auth.json，
 * 用 vendored pi 的 auth check 验证）。
 */
export function App(): JSX.Element {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [stats, setStats] = useState<StatsState>(ZERO_STATS);
  const [streamSpeed, setStreamSpeed] = useState<number | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());

  function toggleExpanded(id: string): void {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  function patchOrCreateItem(
    id: string,
    patch: {
      kind: ItemKind;
      title?: string;
      state?: string;
      text?: string;
      args?: string;
      output?: string;
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
        patchOrCreateItem(id, {
          kind: "tool",
          title,
          state: isError ? "失败" : "完成",
          ...(output !== undefined ? { output } : {}),
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
      const method = payload.request.method;
      const title = str(payload.request["title"]) ?? str(payload.request["message"]) ?? "";
      pushItem({
        kind: "system",
        id: `ui-${++msgSeq}`,
        text: `扩展请求（${method}）${title === "" ? "" : `：${title}`} —— 对话框渲染还在下一步，超时会自动处理`,
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
    const ws = workspace; // 嵌套函数里 TS 不做收窄，闭包捕获会丢 string | null 的窄化
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

  async function openWorkspace(): Promise<void> {
    setStartError(null);
    const path = await window.piGui.openWorkspace();
    if (path === null) return;
    try {
      const snapshot = await window.piGui.startEngine(path);
      setWorkspace(path);
      setStatus(snapshot.status);
      pushItem({
        kind: "system",
        id: `open-${Date.now()}`,
        text: `已打开目录并启动引擎（pid ${snapshot.pid ?? "?"}）`,
      });
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (workspace === null || text.length === 0) return;
    setInput("");
    pushItem({ kind: "user", id: `user-${Date.now()}`, text });
    const behavior = busyRef.current ? "steer" : undefined;
    await window.piGui.prompt(workspace, text, behavior);
    streamEndRef.current?.scrollIntoView({ block: "end" });
  }

  async function abort(): Promise<void> {
    if (workspace === null) return;
    await window.piGui.abort(workspace);
  }

  const items = itemsRef.current;

  return (
    <div className="app">
      <header className="topbar">
        <div className="ws-name">{workspace ?? "未选择工作区"}</div>
        <div className={`engine-state ${status}`}>
          <span className="dot" />
          {status}
        </div>
        <div className="spacer" />
        <ModelPicker workspace={workspace} />
        <AccountButton onChanged={() => rerender()} />
        <button className="btn ghost" onClick={() => void openWorkspace()} disabled={busy}>
          {workspace === null ? "选择工作区" : "更换工作区"}
        </button>
      </header>

      <main className="stream">
        {startError !== null && (
          <div className="start-error">
            <strong>引擎启动失败</strong>
            <pre>{startError}</pre>
          </div>
        )}
        {items.length === 0 && workspace === null && (
          <p className="empty">先选一个工作区（本地目录），agent 会在里面干活。</p>
        )}
        {items.length === 0 && workspace !== null && (
          <p className="empty">
            {status === "ready" ? "引擎已就绪。说一句话开始。" : "引擎启动中…"}
          </p>
        )}
        <div className="wrap">
          {items.map((item) => (
            <ItemView
              key={item.id}
              item={item}
              expanded={expandedIds.has(item.id)}
              onToggle={() => toggleExpanded(item.id)}
            />
          ))}
        </div>
        <div ref={streamEndRef} />
      </main>

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
    </div>
  );
}

function toStats(data: SessionStatsData | null): StatsState {
  if (data === null) return ZERO_STATS;
  const tokens = asRecord(data["tokens"]);
  const input = num(tokens["input"]);
  const output = num(tokens["output"]);
  const cacheRead = num(tokens["cacheRead"]);
  // 缓存命中率 = 命中 / (未命中输入 + 命中)
  const cacheHitPct =
    input + cacheRead > 0 ? (cacheRead / (input + cacheRead)) * 100 : null;
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
      <div className="ctx-track" title={stats.ctxTokens === null ? "上下文不可用" : `${stats.ctxTokens} / ${stats.ctxWindow}`}>
        <div className="ctx-fill" style={ctxPct === null ? {} : { width: `${ctxPct}%` }} />
      </div>
      <span className="stat ctx-num">
        {stats.ctxTokens !== null ? `${formatCount(stats.ctxTokens)}/${formatCount(stats.ctxWindow ?? 0)}` : "—"}
      </span>
      <span className={`stat speed ${busy ? "" : "dim"}`}>
        速度 {speed !== null && speed > 0 ? `${speed.toFixed(1)} tok/s` : "—"}
      </span>
      {stats.cost > 0 && <span className="stat cost">费用 ${stats.cost.toFixed(2)}</span>}
    </div>
  );
}

function AccountButton({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<Array<{ provider: string; type: string; keyMasked: string }>>([]);
  const [provider, setProvider] = useState("openai");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  function refreshList(): void {
    void window.piGui.listCredentials().then(setProviders);
  }

  useEffect(() => {
    if (open) refreshList();
  }, [open]);

  async function save(): Promise<void> {
    if (provider.trim().length === 0 || key.trim().length === 0) return;
    setSaving(true);
    setOutcome(null);
    const result = await window.piGui.setCredential(provider.trim().toLowerCase(), key.trim());
    setSaving(false);
    if (!result.ok) {
      setOutcome({ ok: false, text: result.error ?? "保存失败" });
      return;
    }
    const check = result.check;
    if (check === undefined) {
      setOutcome({ ok: true, text: "已保存（未验证）" });
    } else if (check.status === "ready") {
      setOutcome({ ok: true, text: `已保存，${provider} 就绪` });
    } else {
      const detail = check.reason ?? check.message ?? "凭据未被识别";
      setOutcome({ ok: false, text: `已保存，但未就绪：${detail}` });
    }
    setKey("");
    refreshList();
    onChanged();
  }

  async function remove(providerName: string): Promise<void> {
    await window.piGui.removeCredential(providerName);
    refreshList();
    onChanged();
  }

  return (
    <>
      <button className="btn ghost" onClick={() => setOpen(true)}>
        账号
      </button>
      {open && (
        <div className="sheet-mask" onClick={() => setOpen(false)}>
          <div className="sheet" onClick={(event) => event.stopPropagation()}>
            <h2>账号与凭据</h2>
            <p className="sheet-sub">
              凭据写入 <code>~/.pi/agent/auth.json</code>（pi 自己的格式），保存后用
              <code> pi auth check</code> 验证。OAuth 订阅登录（Claude Pro、Codex 等）在下一步。
            </p>

            <div className="cred-list">
              {providers.length === 0 && <p className="cred-empty">还没有配置任何 provider。</p>}
              {providers.map((entry) => (
                <div key={entry.provider} className="cred-row">
                  <code>{entry.provider}</code>
                  <span className="cred-type">{entry.type}</span>
                  <span className="cred-key">{entry.keyMasked}</span>
                  <button
                    className="btn ghost small"
                    onClick={() => void remove(entry.provider)}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>

            <div className="cred-form">
              <input
                list="pi-providers"
                placeholder="provider（如 openai、anthropic、radius）"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
              />
              <datalist id="pi-providers">
                {PROVIDER_DATALIST.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <input
                type="password"
                placeholder="API Key / Token"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
              <button className="btn primary" onClick={() => void save()} disabled={saving}>
                {saving ? "保存并验证…" : "保存并验证"}
              </button>
            </div>

            {outcome !== null && (
              <p className={`cred-outcome ${outcome.ok ? "ok" : "bad"}`}>{outcome.text}</p>
            )}

            <button className="btn ghost sheet-close" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      )}
    </>
  );
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

/**
 * 模型选择器：按供应商分组列出可用模型（供应商在这里是选择维度，
 * 凭据与开关在账号页），底部是思考等级。选择会持久化为 session 默认。
 */
function ModelPicker({ workspace }: { workspace: string | null }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ModelPickerData | null>(null);
  const [configured, setConfigured] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function toggle(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (!next || workspace === null) return;
    setError(null);
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

function ItemView({
  item,
  expanded,
  onToggle,
}: {
  item: Item;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  if (item.kind === "user") {
    return (
      <div className="me">
        <div className="who">你</div>
        <div className="me-text">{item.text}</div>
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
            <span className={`tool-state ${item.state === "失败" ? "bad" : ""}`}>
              {item.state}
            </span>
          )}
          <span className={`tool-caret ${expanded ? "open" : ""}`}>▾</span>
        </button>
        {expanded && (
          <div className="tool-details">
            {item.args !== undefined && (
              <div className="tool-detail-block">
                <div className="tool-detail-label">参数</div>
                <pre className="tool-args">{item.args}</pre>
              </div>
            )}
            {item.output !== undefined && (
              <div className="tool-detail-block">
                <div className="tool-detail-label">输出</div>
                <pre className="tool-output">{item.output}</pre>
              </div>
            )}
            {item.args === undefined && item.output === undefined && (
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