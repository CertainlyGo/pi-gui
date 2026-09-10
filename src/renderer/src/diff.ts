/**
 * 轻量 unified diff 解析（渲染 edit/write 类工具的 details.diff）。
 * 不追求完整规范 —— 只认 pi 的编辑工具产出的格式：@@ 头、+ - 空行。
 */

export type DiffRowKind = "file" | "hunk" | "add" | "del" | "ctx" | "meta";

export interface DiffRow {
  readonly kind: DiffRowKind;
  readonly text: string;
  readonly lineNumber: number | null;
}

export interface ParsedDiff {
  readonly rows: readonly DiffRow[];
  readonly additions: number;
  readonly deletions: number;
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  let addLine = 0;
  let delLine = 0;

  const lines = text.split("\n");
  for (const raw of lines) {
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ")
    ) {
      rows.push({ kind: "file", text: raw, lineNumber: null });
      inHunk = false;
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      addLine = match === null ? 0 : Number(match[2]);
      delLine = match === null ? 0 : Number(match[1]);
      rows.push({ kind: "hunk", text: raw, lineNumber: null });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", text: raw, lineNumber: addLine === 0 ? null : addLine++ });
      additions += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      rows.push({ kind: "del", text: raw, lineNumber: delLine === 0 ? null : delLine++ });
      deletions += 1;
      continue;
    }
    if (raw.startsWith("\\")) {
      rows.push({ kind: "meta", text: raw, lineNumber: null });
      continue;
    }
    rows.push({ kind: "ctx", text: raw, lineNumber: delLine === 0 ? null : delLine++ });
  }
  return { rows, additions, deletions };
}