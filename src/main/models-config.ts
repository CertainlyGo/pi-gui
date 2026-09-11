import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * `~/.pi/agent/models.json` 的只读合并与 provider 覆盖写入。
 *
 * 自定义/网关 baseUrl 走 pi 文档化的 models.json 结构：
 * `{ "providers": { "openai": { "baseUrl": "..." } } }`，
 * pi 会把这层覆盖叠在原生 provider 之上（docs/custom-provider.md）。
 * 写入是合并式的：只改目标 provider 的 baseUrl，其余内容原样保留。
 */

export type ApiFormat = "openai" | "anthropic";

export class ModelsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelsConfigError";
  }
}

/** 读取 models.json；文件不存在 → 空结构。损坏时抛错，绝不静默覆盖。 */
export async function readModelsConfig(path: string): Promise<Record<string, unknown>> {
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
    throw new ModelsConfigError(
      `models.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ModelsConfigError("models.json 必须是对象");
  }
  return parsed as Record<string, unknown>;
}

/** 覆盖某 provider 的 baseUrl（合并写入，保留文件里其它内容）。 */
export async function setProviderBaseUrl(
  path: string,
  provider: ApiFormat,
  baseUrl: string,
): Promise<void> {
  const current = await readModelsConfig(path);
  const providers = readObjectField(current, "providers");
  const entry = readObjectField(providers, provider);
  const next = {
    ...current,
    providers: {
      ...providers,
      [provider]: { ...entry, baseUrl },
    },
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function readObjectField(container: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = container[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}