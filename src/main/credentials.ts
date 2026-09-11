import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 凭据文件的读写。
 *
 * 这是 ADR-0002 的窄例外：pi 的 SDK 没有导出凭据写入器、CLI 也没有写命令
 * （TUI 的 `/login` 是唯一官方写入路径，GUI 用不了），所以 auth.json 由我们
 * 直接读写 —— 但只碰这一个文件，schema 按 docs/providers.md 的文档化格式，
 * 并且每次写入后都跑 `pi auth check --json` 验证，绝不静默假设写对了。
 */

export const AUTH_FILE_MODE = 0o600;

export type Credential =
  | { type: "api_key" | "bearer_token"; key: string; [extra: string]: unknown }
  | { type: "oauth"; access: string; refresh: string; expires: number; [extra: string]: unknown };

export type AuthFile = Record<string, Credential>;

export class AuthFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthFileError";
  }
}

/** 读取 auth.json。文件不存在 → 空对象；JSON 损坏 → 抛错，绝不静默覆盖。 */
export async function loadAuthFile(path: string): Promise<AuthFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new AuthFileError(
      `auth.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuthFileError("auth.json 必须是对象");
  }
  const result: AuthFile = {};
  for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AuthFileError(`auth.json 里 ${provider} 的凭据不是对象`);
    }
    const entry = value as Partial<Credential>;
    const type = entry["type"];
    if (type === "oauth") {
      const oauth = value as Record<string, unknown>;
      if (
        typeof oauth["access"] !== "string" ||
        typeof oauth["refresh"] !== "string" ||
        typeof oauth["expires"] !== "number"
      ) {
        throw new AuthFileError(`auth.json 里 ${provider} 的 oauth 凭据缺 access/refresh/expires`);
      }
      result[provider] = value as Credential;
      continue;
    }
    if (type !== "api_key" && type !== "bearer_token") {
      throw new AuthFileError(`auth.json 里 ${provider} 的 type 无效`);
    }
    if (typeof entry["key"] !== "string") {
      throw new AuthFileError(`auth.json 里 ${provider} 缺少 key`);
    }
    result[provider] = value as Credential;
  }
  return result;
}

/** 合并写入一个 provider 的凭据，保留文件里其它 provider 不动。 */
export async function saveCredential(
  path: string,
  provider: string,
  credential: Credential,
): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
    throw new AuthFileError(`非法 provider 名：${provider}`);
  }
  const current = await loadAuthFile(path);
  const next: AuthFile = { ...current, [provider]: credential };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: AUTH_FILE_MODE });
  // Windows 上 chmod 基本是空操作（权限由 ACL 管），失败可以忽略。
  await chmod(path, AUTH_FILE_MODE).catch(() => undefined);
}

export async function removeCredential(path: string, provider: string): Promise<boolean> {
  const current = await loadAuthFile(path);
  if (!(provider in current)) return false;
  const rest: AuthFile = {};
  for (const [name, credential] of Object.entries(current)) {
    if (name !== provider) rest[name] = credential;
  }
  await writeFile(path, `${JSON.stringify(rest, null, 2)}\n`, { mode: AUTH_FILE_MODE });
  return true;
}

export interface AuthCheckOutcome {
  readonly ok: boolean;
  readonly status: "ready" | "not_ready" | "error";
  readonly reason?: string;
  readonly message?: string;
}

/**
 * 用 vendored pi 自己的 `auth check --json` 验证凭据是否被识别。
 * `--no-refresh`：只在本地判定，不因验证流程去刷新 OAuth。
 */
export function checkProviderAuth(options: {
  readonly nodeExecPath: string;
  readonly cliPath: string;
  readonly provider: string;
  readonly timeoutMs?: number;
}): Promise<AuthCheckOutcome> {
  return new Promise<AuthCheckOutcome>((resolve) => {
    const child = spawn(
      options.nodeExecPath,
      [
        options.cliPath,
        "auth",
        "check",
        "--provider",
        options.provider,
        "--json",
        "--no-refresh",
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 20_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as {
          status?: string;
          provider?: string;
          reason?: string;
          message?: string;
        };
        resolve({
          ok: parsed["status"] === "ready",
          status: parsed["status"] === "ready" ? "ready" : "not_ready",
          ...(parsed["reason"] !== undefined ? { reason: parsed["reason"] } : {}),
          ...(parsed["message"] !== undefined ? { message: parsed["message"] } : {}),
        });
      } catch {
        resolve({
          ok: false,
          status: "error",
          ...(code !== 0 ? { reason: `退出码 ${code ?? "?"}` } : {}),
          message: stderr.slice(0, 500) || "无法解析 auth check 输出",
        });
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, status: "error", message: error.message });
    });
  });
}