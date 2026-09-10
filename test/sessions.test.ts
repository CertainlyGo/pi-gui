import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { describe, it } from "node:test";
import { listWorkspaceSessions, workspaceSessionDir } from "../src/main/sessions.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-gui-sessions-"));
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("workspaceSessionDir", () => {
  it("按 pi 的 safePath 约定编码（-- 路径转短横线 --）", () => {
    assert.equal(
      workspaceSessionDir(dir, "C:/Users/gg/ws"),
      join(dir, "sessions", "--C--Users-gg-ws--"),
    );
  });
});

describe("listWorkspaceSessions", () => {
  it("列出目录下的 session，展示名取首条 session_info", async () => {
    const sessionDir = workspaceSessionDir(dir, "C:/Users/gg/ws");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "a.jsonl"),
      '{"type":"session_info","id":"s1","name":"修登录"}\n{"type":"user_message"}\n',
      "utf8",
    );
    await writeFile(
      join(sessionDir, "b.jsonl"),
      '{"type":"user_message"}\n',
      "utf8",
    );
    const sessions = await Promise.resolve(listWorkspaceSessions(dir, "C:/Users/gg/ws"));
    assert.equal(sessions.length, 2);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    assert.equal(byId.get("s1")?.name, "修登录");
    // b.jsonl 首条不是 session_info → 退回 id 前缀
    const b = [...byId.values()].find((s) => s.id !== "s1");
    assert.ok(b !== undefined);
    assert.equal(b.name.length > 0, true);
  });

  it("单文件损坏不打断列表；目录不存在返回空", async () => {
    // 一个读不了的文件（这里是目录冒充 .jsonl）必须被跳过，而不是拖垮整个列表
    await mkdir(join(dir, "sessions", "--C--Users-gg-ws--", "broken.jsonl"), { recursive: true });
    const sessions = listWorkspaceSessions(dir, "C:/Users/gg/ws");
    assert.equal(sessions.length, 2); // a + b，broken 被跳过
    assert.deepEqual(listWorkspaceSessions(dir, "C:/nope"), []);
  });
});