import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Session 列表（管理面的只读展示）。
 *
 * 布局：`~/.pi/agent/sessions/<--路径转短横线-->/*.jsonl`（路径编码是 pi 自己
 * 的约定，规则见 session-manager.ts 的 safePath）。展示名为首条 session_info
 * 记录里的 name；没有的退回文件名的 id 前缀。单个文件损坏不影响整体列表。
 */

/** `C:/Users/gg/ws` → `--C--Users-gg-ws--`（跟 pi 的 safePath 完全一致，冒号也算一个 `-`）。 */
export function workspaceSessionDir(agentDir: string, workspace: string): string {
  const resolvedCwd = resolve(workspace);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

export interface SessionSummary {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly updatedAt: number;
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
      const firstLine = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
      let id = basename(entry, ".jsonl");
      let name = "";
      try {
        const record = JSON.parse(firstLine) as Record<string, unknown>;
        if (typeof record["id"] === "string" && record["id"].length > 0) id = record["id"];
        if (typeof record["name"] === "string" && record["name"].length > 0) name = record["name"];
      } catch {
        // 老会话没有首条 session_info，退回文件名。
      }
      sessions.push({ id, name: name || id.slice(0, 8), path, updatedAt });
    } catch {
      // 单个文件不可读不影响列表。
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}