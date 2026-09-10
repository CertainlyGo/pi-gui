import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { EngineEventPayload } from "../../shared/ipc-contract.ts";

type ItemKind = "user" | "assistant" | "tool" | "bash" | "system";

interface Item {
  readonly kind: ItemKind;
  readonly id: string;
  title?: string;
  state?: string;
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 垂直切片：打开工作区 → 启动引擎 → 发 prompt → 把事件流渲染成基础卡片。
 * 按原型的方向排版，但不去追求视觉完成度 —— 那一步等原型回看之后再做。
 */
export function App(): JSX.Element {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const itemsRef = useRef<Item[]>([]);
  const itemIdsRef = useRef<string[]>([]);
  const [, setTick] = useState(0);
  const busyRef = useRef(false);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  function rerender(): void {
    setTick((tick) => tick + 1);
  }

  function pushItem(item: Item): void {
    itemsRef.current.push(item);
    itemIdsRef.current.push(item.id);
    rerender();
  }

  function patchItem(id: string, patch: Partial<Item>): void {
    const index = itemIdsRef.current.indexOf(id);
    if (index === -1) {
      // 新 id：建一个基础条目（工具卡片开始/更新共用）
      pushItem({ kind: "tool", id, text: "", ...patch });
      return;
    }
    const existing = itemsRef.current[index]!;
    itemsRef.current[index] = { ...existing, ...patch };
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
    let seq = 0;

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
        const id = str(record["id"]) ?? `assistant-${++seq}`;
        upsertStreamingText(id, "");
        return;
      }
      if (type === "message_update") {
        const id = str(record["id"]) ?? `assistant-${++seq}`;
        const text = str(record["text"]) ?? "";
        const index = itemIdsRef.current.indexOf(id);
        const current = index === -1 ? undefined : itemsRef.current[index];
        upsertStreamingText(id, (current?.text ?? "") + text);
        return;
      }
      if (type === "tool_execution_start" || type === "tool_execution_update") {
        const id = str(record["id"]) ?? `tool-${++seq}`;
        const title = str(record["toolName"]) ?? str(record["name"]) ?? "工具";
        const state = str(record["state"]);
        patchItem(id, { kind: "tool", title, ...(state !== undefined ? { state } : {}) });
        return;
      }
      if (type === "bash_execution_update") {
        const id = str(record["id"]) ?? `bash-${++seq}`;
        const title = str(record["command"]) ?? "shell";
        const state = str(record["state"]);
        patchItem(id, { kind: "bash", title, ...(state !== undefined ? { state } : {}) });
        return;
      }
      if (type === "extension_error") {
        const message = str(record["message"]) ?? str(record["error"]) ?? "扩展出错";
        pushItem({ kind: "system", id: `err-${++seq}`, text: message });
      }
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
        id: `ui-${++seq}`,
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

  async function openWorkspace(): Promise<void> {
    setStartError(null);
    const path = await window.piGui.openWorkspace();
    if (path === null) return;
    try {
      const snapshot = await window.piGui.startEngine(path);
      setWorkspace(path);
      setStatus(snapshot.status);
      pushItem({ kind: "system", id: `open-${Date.now()}`, text: `已打开目录并启动引擎（pid ${snapshot.pid ?? "?"}）` });
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
          <p className="empty">引擎已就绪。说一句话开始。</p>
        )}
        <div className="wrap">
          {items.map((item) => (
            <ItemView key={item.id} item={item} />
          ))}
        </div>
        <div ref={streamEndRef} />
      </main>

      <footer className="composer">
        <div className="composer-inner">
          <textarea
            rows={1}
            placeholder={workspace === null ? "先选择工作区" : busy ? "补充说明（agent 完成当前动作后处理）" : "说点什么…"}
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
            <span className="hint">{workspace === null ? "尚未连接引擎" : "Enter 发送 · Shift+Enter 换行"}</span>
            {busy ? (
              <button className="btn warn" onClick={() => void abort()}>停止</button>
            ) : (
              <button className="btn primary" onClick={() => void send()} disabled={workspace === null || input.trim().length === 0}>
                发送
              </button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}

function ItemView({ item }: { item: Item }): JSX.Element {
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
    // ADR-0003: bash 前面的「未启用 shell」闸门在工具白名单落盘后接入，这里先透出状态。
    return (
      <div className="tool-card">
        <span className="tool-type">{item.kind === "bash" ? "shell" : "工具"}</span>
        <code>{item.title}</code>
        {item.state !== undefined && <span className="tool-state">{item.state}</span>}
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