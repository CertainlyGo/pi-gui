import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 插件市场（Round 3 第 2 问：v1 = npm 的 `pi-package` 关键字搜索 + 安装 UI，
 * 零后端）。搜索是只读 HTTP 调用；安装/更新/卸载一律 shell out 到 vendored pi
 * 自己的命令（ADR-0002 允许的通道），绝不自己实现 npm 安装语义。
 */

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";

export interface MarketPackage {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly publisher: string;
  readonly updatedAt: string;
  readonly downloadsLastWeek: number;
}

/** 纯映射，便于测试。 */
export function mapSearchResponse(body: unknown): MarketPackage[] {
  if (body === null || typeof body !== "object") return [];
  const objects = (body as Record<string, unknown>)["objects"];
  if (!Array.isArray(objects)) return [];
  const result: MarketPackage[] = [];
  for (const entry of objects) {
    const pkg = readObj(readObj(entry)["package"]);
    const name = typeof pkg["name"] === "string" ? pkg["name"] : "";
    if (name.length === 0) continue;
    const detail = readObj(readObj(readObj(entry)["score"])["detail"]);
    const downloads = typeof detail["downloads"] === "number" ? (detail["downloads"] as number) : 0;
    const publisher = readObj(pkg["publisher"])["username"];
    result.push({
      name,
      version: typeof pkg["version"] === "string" ? pkg["version"] : "?",
      description: typeof pkg["description"] === "string" ? pkg["description"] : "",
      publisher: typeof publisher === "string" ? publisher : "?",
      updatedAt: typeof pkg["date"] === "string" ? pkg["date"] : "",
      downloadsLastWeek: downloads,
    });
  }
  return result;
}

function readObj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export async function searchPiPackages(
  query: string,
  size = 24,
  fetchImpl: typeof fetch = fetch,
): Promise<MarketPackage[]> {
  const params = new URLSearchParams({
    text: query.trim().length > 0 ? `keywords:pi-package ${query.trim()}` : "keywords:pi-package",
    size: String(size),
  });
  let lastError: unknown;
  // 一次快速重试：这个网络环境里有偶发超时（Cloudflare 边缘）。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(`${NPM_SEARCH_URL}?${params}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`npm 搜索失败：HTTP ${response.status}`);
      }
      return mapSearchResponse(await response.json());
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type InstallScope = "global" | "project";

interface CliRunOptions {
  readonly nodeExecPath: string;
  readonly cliPath: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}

function runPiCli(
  options: CliRunOptions,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(options.nodeExecPath, [options.cliPath, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ ok: true });
        return;
      }
      const detail = (stderr.trim() || stdout.trim()).slice(0, 600);
      resolvePromise({ ok: false, error: detail || `退出码 ${code ?? "?"}` });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: error.message });
    });
  });
}

export function installPiPackage(
  options: CliRunOptions & { readonly spec: string; readonly scope: InstallScope },
): Promise<{ ok: boolean; error?: string }> {
  const args = ["install", ...(options.scope === "project" ? ["-l"] : []), options.spec];
  return runPiCli(options, args, options.timeoutMs ?? 180_000);
}

export function updatePiPackage(
  options: CliRunOptions & { readonly spec: string; readonly scope: InstallScope },
): Promise<{ ok: boolean; error?: string }> {
  const args = ["update", ...(options.scope === "project" ? ["-l"] : []), options.spec];
  return runPiCli(options, args, options.timeoutMs ?? 180_000);
}

export function removePiPackage(
  options: CliRunOptions & { readonly spec: string; readonly scope: InstallScope },
): Promise<{ ok: boolean; error?: string }> {
  const args = ["remove", ...(options.scope === "project" ? ["-l"] : []), options.spec];
  return runPiCli(options, args, options.timeoutMs ?? 60_000);
}

/** 已安装包：读 用户级 + 项目级 settings.json 的 packages 数组（只读展示）。 */
export async function listInstalledPackages(agentDir: string, workspace: string): Promise<string[]> {
  const specs = new Set<string>();
  for (const file of [join(agentDir, "settings.json"), join(workspace, ".pi", "settings.json")]) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const packages = parsed["packages"];
      if (Array.isArray(packages)) {
        for (const spec of packages) {
          if (typeof spec === "string" && spec.length > 0) specs.add(spec);
        }
      }
    } catch {
      // 文件缺失或损坏：跳过，不打断其它来源。
    }
  }
  return [...specs].sort();
}