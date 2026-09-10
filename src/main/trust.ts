import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

/**
 * 项目信任（ADR-0006）。
 *
 * 检测逻辑按 docs/security.md 的资源清单：`.pi/settings.json`、
 * `.pi/extensions|skills|prompts|themes`、`.pi/SYSTEM.md|APPEND_SYSTEM.md`，
 * 以及当前或祖先目录里的项目 `.agents/skills`。
 *
 * 决策写进 pi 自己的 `~/.pi/agent/trust.json` —— 走 SDK 的 ProjectTrustStore
 * （ADR-0002 认可的进程内 SDK 路径，不是手写文件）。
 */

export type TrustDecision = "ask" | "always" | "never" | null;

export interface TrustStore {
  decision(dir: string): TrustDecision;
  decide(dir: string, decision: Exclude<TrustDecision, null>): void;
}

export function createTrustStore(agentDir: string): TrustStore {
  const store = new ProjectTrustStore(agentDir);
  return {
    // trust.json 存布尔：true=信任、false=不信任、null=未决定（= ask）
    decision: (dir) => {
      const saved = store.get(dir);
      return saved === null ? "ask" : saved ? "always" : "never";
    },
    decide: (dir, decision) => store.set(dir, decision === "always"),
  };
}

interface Signal {
  readonly label: string;
  readonly relative: string;
  readonly kind: "file" | "dir";
}

const LOCAL_SIGNALS: readonly Signal[] = [
  { label: ".pi/settings.json", relative: ".pi/settings.json", kind: "file" },
  { label: ".pi/extensions/", relative: ".pi/extensions", kind: "dir" },
  { label: ".pi/skills/", relative: ".pi/skills", kind: "dir" },
  { label: ".pi/prompts/", relative: ".pi/prompts", kind: "dir" },
  { label: ".pi/themes/", relative: ".pi/themes", kind: "dir" },
  { label: ".pi/SYSTEM.md", relative: ".pi/SYSTEM.md", kind: "file" },
  { label: ".pi/APPEND_SYSTEM.md", relative: ".pi/APPEND_SYSTEM.md", kind: "file" },
];

function hasKind(path: string, kind: "file" | "dir"): boolean {
  try {
    if (!existsSync(path)) return false;
    const stats = statSync(path);
    return kind === "file" ? stats.isFile() : stats.isDirectory();
  } catch {
    return false;
  }
}

/** 列出需要信任的资源标签（祖先目录的注明位置）。 */
export function detectTrustResources(dir: string): string[] {
  const found: string[] = [];
  for (const signal of LOCAL_SIGNALS) {
    if (hasKind(join(dir, signal.relative), signal.kind)) found.push(signal.label);
  }
  const root = resolve(dir);
  for (let ancestor = root; ; ) {
    const skills = join(ancestor, ".agents", "skills");
    if (hasKind(skills, "dir")) {
      found.push(ancestor === root ? "项目 .agents/skills" : `项目 .agents/skills（位于 ${ancestor}）`);
      break;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return found;
}