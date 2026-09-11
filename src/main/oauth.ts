import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { shell } from "electron";
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";
import type { AuthEvent, AuthPrompt, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

/**
 * OAuth 订阅登录（Claude Pro/Max、Codex、Copilot、Grok、OpenRouter、Kimi、Radius）。
 *
 * 复用 pi 自己的登录机器：provider 的 PKCE 流程（loopback 回调服务器、客户端 ID、
 * token 交换）都在 `@earendil-works/pi-ai/dist/auth/oauth/` 里，但公开导出只给了
 * 类型不给实现 —— 所以从绝对文件路径深 import（pi 版本被 ADR-0005 钉死，路径稳定）。
 * 我们只实现两层薄壳：把 `prompt()` 桥到渲染层弹窗响应，把 `notify()` 桥到
 * 渲染层进度 + 用 `shell.openExternal` 开授权页。token 存成 pi 的规范
 * `OAuthCredential` 形状（`{type:"oauth", access, refresh, expires}`），
 * `pi auth check` 能直接验证。
 */

export type OAuthProvider =
  | "anthropic"
  | "openai-codex"
  | "github-copilot"
  | "openrouter"
  | "kimi-coding"
  | "xai"
  | "radius";

export const OAUTH_PROVIDERS: readonly { id: OAuthProvider; label: string }[] = [
  { id: "openai-codex", label: "OpenAI Codex（ChatGPT 订阅）" },
  { id: "anthropic", label: "Claude Pro / Max" },
  { id: "github-copilot", label: "GitHub Copilot" },
  { id: "xai", label: "xAI（Grok / X Premium）" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "kimi-coding", label: "Kimi Coding" },
  { id: "radius", label: "Radius（pi 网关）" },
];

const LOADER_NAMES: Record<OAuthProvider, string> = {
  anthropic: "loadAnthropicOAuth",
  "openai-codex": "loadOpenAICodexOAuth",
  "github-copilot": "loadGitHubCopilotOAuth",
  openrouter: "loadOpenRouterOAuth",
  "kimi-coding": "loadKimiCodingOAuth",
  xai: "loadXaiOAuth",
  radius: "loadRadiusOAuth",
};

export interface OAuthRunnerHandlers {
  readonly onPrompt: (prompt: AuthPrompt) => Promise<string>;
  readonly onNotify: (event: AuthEvent) => void;
}

export async function runOAuthLogin(
  provider: OAuthProvider,
  handlers: OAuthRunnerHandlers,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const auth = await loadOAuthAuth(provider);
  const interaction = {
    signal,
    prompt: async (prompt: AuthPrompt): Promise<string> => handlers.onPrompt(prompt),
    notify: (event: AuthEvent): void => handlers.onNotify(event),
  };
  return auth.login(interaction);
}

async function loadOAuthAuth(provider: OAuthProvider): Promise<OAuthAuth> {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
  const packageRoot = dirname(dirname(packageEntry));
  const loadUrl = pathToFileURL(
    join(packageRoot, "dist", "auth", "oauth", "load.js"),
  ).href;
  const loaderName = LOADER_NAMES[provider];
  const module = (await import(loadUrl)) as Record<string, unknown>;
  const loader = module[loaderName] as ((options?: unknown) => Promise<OAuthAuth>) | undefined;
  if (loader === undefined) {
    throw new Error(`找不到 OAuth loader：${provider}（${loaderName}）`);
  }
  if (provider === "radius") {
    return await loader({ name: "Radius", gateway: DEFAULT_RADIUS_GATEWAY });
  }
  return await loader();
}

/** notify 事件里出现授权链接时开浏览器；返回是否已处理。 */
export function handleAuthNotifyForBrowser(event: AuthEvent): boolean {
  if (event.type === "auth_url" && typeof event.url === "string") {
    void shell.openExternal(event.url);
    return true;
  }
  return false;
}