import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { describe, it } from "node:test";
import {
  ModelsConfigError,
  readModelsConfig,
  setProviderBaseUrl,
} from "../src/main/models-config.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-gui-models-"));
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("models-config", () => {
  it("文件不存在 → 空结构；写入后保留其它 provider", async () => {
    const path = join(dir, "models.json");
    assert.deepEqual(await readModelsConfig(path), {});
    await setProviderBaseUrl(path, "openai", "https://gw.example.com/v1");
    const afterWrite = await readModelsConfig(path);
    const providers = afterWrite["providers"] as Record<string, unknown>;
    const openai = providers["openai"] as Record<string, unknown>;
    assert.equal(openai["baseUrl"], "https://gw.example.com/v1");
  });

  it("合并写入：不动既有 provider 的内容", async () => {
    const path = join(dir, "models2.json");
    await writeFile(
      path,
      JSON.stringify({
        providers: {
          ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "qwen" }] },
        },
      }),
      "utf8",
    );
    await setProviderBaseUrl(path, "anthropic", "https://claude-gw.example.com");
    const result = await readModelsConfig(path);
    const providers = result["providers"] as Record<string, unknown>;
    const ollama = providers["ollama"] as Record<string, unknown>;
    assert.equal(ollama["baseUrl"], "http://localhost:11434/v1");
    assert.equal(ollama["api"], "openai-completions");
    const anthropic = providers["anthropic"] as Record<string, unknown>;
    assert.equal(anthropic["baseUrl"], "https://claude-gw.example.com");
  });

  it("损坏的 models.json 抛错而不是静默覆盖", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "not-json{{", "utf8");
    await assert.rejects(readModelsConfig(path), ModelsConfigError);
    await assert.rejects(setProviderBaseUrl(path, "openai", "x"), ModelsConfigError);
  });

  it("写入结果再次读取一致", async () => {
    const path = join(dir, "roundtrip.json");
    await setProviderBaseUrl(path, "openai", "https://api.openai.com/v1");
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const baseUrl = (raw["providers"] as Record<string, unknown>)?.["openai"] as Record<string, unknown> | undefined;
    assert.equal(baseUrl !== undefined && "baseUrl" in baseUrl ? baseUrl["baseUrl"] : undefined, "https://api.openai.com/v1");
  });
});