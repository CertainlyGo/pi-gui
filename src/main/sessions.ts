import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Session 列表（管理面的只读展示）。
 *
 * 布局：`~/.pi/agent/sessions/<--路径转短横线-->/*.jsonl`（路径编码是 pi 自己
 * 的约定，规则见 session-manager.ts 的 safePath）。
 *
 * 展示名优先级：`session_info.name` > 首条用户消息的文本（会话用第一条问题命名）
 * > id 前缀。单个文件损坏不影响整体列表。
 */

const HEAD_SCAN_LINES = 200;
const NAME_LIMIT = 40;

export interface SessionSummary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly updatedAt: number;
}

/** `C:/Users/gg/ws` → `--C--Users-gg-ws--`（跟 pi 的 safePath 完全一致，冒号也算一个 `-`）。 */
export function workspaceSessionDir(agentDir: string, workspace: string): string {
  const resolvedCwd = resolve(workspace);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  const text = asRecord(value)["text"];
  if (typeof text === "string" && text.length > 0) return text;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      const textPart = asRecord(part)["text"];
      if (typeof textPart === "string" && textPart.length > 0) parts.push(textPart);
    }
    return parts.join(" ");
  }
  return "";
}

function truncate(text: string, limit: number): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > limit ? `${firstLine.slice(0, limit)}…` : firstLine;
}

/** 会话文件的展示名：session_info.name > 首条用户消息 > id 前缀。 */
function extractSessionMeta(
  head: readonly string[],
  fallbackId: string,
): { id: string; name: string } {
  let id = fallbackId;
  let firstName = "";
  let firstUserText: string | undefined;
  for (const line of head) {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = record["type"];
    if (type === "session" || type === "session_info") {
      if (typeof record["id"] === "string" && record["id"].length > 0) id = record["id"];
      if (
        type === "session_info" &&
        typeof record["name"] === "string" &&
        record["name"].length > 0
      ) {
        firstName = record["name"];
        break;
      }
    }
    if (type === "message" && firstUserText === undefined) {
      const message = asRecord(record["message"]);
      if (message["role"] === "user") {
        const text = contentText(message["content"]);
        if (text.length > 0) firstUserText = truncate(text, NAME_LIMIT);
      }
    }
  }
  if (firstName.length > 0) return { id, name: firstName };
  if (firstUserText !== undefined && firstUserText.length > 0) return { id, name: firstUserText };
  return { id, name: id.slice(0, 8) };
}

export function listWorkspaceSessions(agentDir: string, workspace: string): SessionSummary[] {
  const dir = workspaceSessionDir(agentDir, workspace);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(dir, entry);
    try {
      const updatedAt = statSync(path).mtimeMs;
      const head = readFileSync(path, "utf8").split("\n", HEAD_SCAN_LINES);
      const fallbackId = basename(entry, ".jsonl");
      const { id, name } = extractSessionMeta(head, fallbackId);
      sessions.push({ id, name, path, updatedAt });
    } catch {
      // 单个文件不可读不影响列表。
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 删除一个 session 文件。只允许删除当前工作区 sessions 目录下的文件，防路径逃逸。 */
export function deleteSessionFile(
  agentDir: string,
  workspace: string,
  sessionPath: string,
): { ok: boolean; error?: string } {
  const sessionsRoot = resolve(workspaceSessionDir(agentDir, workspace));
  const target = resolve(sessionPath);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (!target.startsWith(`${sessionsRoot}${separator}`)) {
    return { ok: false, error: "只能删除当前工作区的会话文件" };
  }
  try {
    rmSync(target, { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}