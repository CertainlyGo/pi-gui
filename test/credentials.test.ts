import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { describe, it } from "node:test";
import { AuthFileError, loadAuthFile, removeCredential, saveCredential } from "../src/main/credentials.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-gui-auth-"));
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("credentials", () => {
  it("文件不存在 → 空对象", async () => {
    assert.deepEqual(await loadAuthFile(join(dir, "missing.json")), {});
  });

  it("非法 JSON → 抛 AuthFileError，绝不静默覆盖", async () => {
    const path = join(dir, "broken.json");
    await writeFile(path, "not-json{{", "utf8");
    await assert.rejects(loadAuthFile(path), AuthFileError);
  });

  it("保存后合并其它 provider，互不影响", async () => {
    const path = join(dir, "merge.json");
    await saveCredential(path, "openai", { type: "api_key", key: "sk-one" });
    await saveCredential(path, "anthropic", { type: "api_key", key: "sk-two" });
    const auth = await loadAuthFile(path);
    assert.equal(auth["openai"]?.key, "sk-one");
    assert.equal(auth["anthropic"]?.key, "sk-two");
  });

  it("保留未识别的额外字段（env 等）", async () => {
    const path = join(dir, "extra.json");
    await saveCredential(path, "proxy", { type: "api_key", key: "k", env: { HTTP_PROXY: "x" } });
    const auth = await loadAuthFile(path);
    const env = auth["proxy"]?.["env"] as Record<string, unknown> | undefined;
    assert.equal(env?.["HTTP_PROXY"], "x");
  });

  it("非法 provider 名被拒绝", async () => {
    await assert.rejects(
      saveCredential(join(dir, "x.json"), "Bad/Name", { type: "api_key", key: "k" }),
      AuthFileError,
    );
  });

  it("removeCredential 只删目标 provider；不存在的返回 false", async () => {
    const path = join(dir, "remove.json");
    await saveCredential(path, "openai", { type: "api_key", key: "a" });
    await saveCredential(path, "google", { type: "api_key", key: "b" });
    assert.equal(await removeCredential(path, "google"), true);
    const auth = await loadAuthFile(path);
    assert.equal(auth["google"], undefined);
    assert.equal(auth["openai"]?.key, "a");
    assert.equal(await removeCredential(path, "github"), false);
  });

  it("损坏的 type / 缺 key 的条目被拒", async () => {
    const path = join(dir, "bad-entries.json");
    await writeFile(
      path,
      '{"openai":{"type":"api_key","key":"ok"},"bad":{"type":"weird","key":"x"},"nokey":{"type":"api_key"}}',
      "utf8",
    );
    await assert.rejects(loadAuthFile(path), AuthFileError);
  });
});