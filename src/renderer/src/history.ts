/**
 * 把 get_messages 返回的 AgentMessage 对象映射成界面条目。
 * 纯函数，便于测试；形状按 packages/agent 的 AgentMessage 防御式解析。
 */

export interface HistoryItem {
  readonly kind: "user" | "assistant" | "tool" | "bash" | "system";
  readonly id: string;
  /** 用户消息的条目 id，用于 fork（从此处进入子会话）。 */
  readonly entryId?: string;
  title?: string;
  state?: string;
  text: string;
  args?: string;
  output?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function prettyJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  const text = str(value);
  if (text !== undefined) return text;
  const content = value;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      const block = asRecord(part);
      const blockType = str(block["type"]);
      if (blockType === "text" || blockType === "thinking") {
        const piece = str(block["text"]) ?? str(block["thinking"]) ?? str(block["content"]);
        if (piece !== undefined) parts.push(piece);
      }
    }
    return parts.join("\n");
  }
  return "";
}

export function mapMessagesToItems(messages: readonly unknown[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  let seq = 0;
  for (const raw of messages) {
    const message = asRecord(raw);
    const type = str(message["type"]);
    const id = str(message["id"]) ?? `hist-${++seq}`;
    const payload = asRecord(message["message"]);

    if (type === "user") {
      const text = contentText(payload["content"]);
      items.push({ kind: "user", id, entryId: id, text });
      continue;
    }

    if (type === "assistant") {
      const blocks = Array.isArray(payload["content"]) ? payload["content"] : [];
      let text = "";
      for (const blockRaw of blocks) {
        const block = asRecord(blockRaw);
        const blockType = str(block["type"]);
        if (blockType === "text" || blockType === "thinking") {
          const piece = str(block["text"]) ?? str(block["thinking"]) ?? str(block["content"]);
          if (piece !== undefined) text += piece;
        } else if (blockType === "tool_use") {
          // 文本与工具调用的先后顺序有意义：先冲掉已累积的文本，再放工具卡。
          if (text.length > 0) {
            items.push({ kind: "assistant", id: `${id}-txt-${++seq}`, text });
            text = "";
          }
          const name = str(block["name"]) ?? "工具";
          const args = prettyJson(block["input"]);
          items.push({
            kind: "tool",
            id: `${id}-t${++seq}`,
            title: name,
            state: "完成",
            ...(args !== undefined ? { args } : {}),
            text: "",
          });
        }
      }
      if (text.length > 0) {
        items.push({ kind: "assistant", id: `${id}-txt`, text });
      }
      continue;
    }

    // tool_result 等不再单独渲染（避免噪音），它们的信息已经落在工具卡里。
  }
  return items;
}