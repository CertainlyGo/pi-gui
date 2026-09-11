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

  it("展示名回退到首条用户消息（会话用第一条问题命名）", async () => {
    const sessionDir = workspaceSessionDir(dir, "C:/Users/gg/ws2");
    await mkdir(sessionDir, { recursive: true });
    // 真实文件结构：首条是 session 头，用户消息随后，名字从未显式设置
    await writeFile(
      join(sessionDir, "real.jsonl"),
      [
        '{"type":"session","version":3,"id":"u1","timestamp":"2026-01-01T00:00:00.000Z"}',
        '{"type":"message","id":"m1","message":{"role":"user","content":"帮我把登录页改成 zod"}}',
        '{"type":"message","id":"m2","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}',
      ].join("\n"),
      "utf8",
    );
    const sessions = listWorkspaceSessions(dir, "C:/Users/gg/ws2");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.name, "帮我把登录页改成 zod");
  });

  it("超长首条问题被截断到 40 字", async () => {
    const sessionDir = workspaceSessionDir(dir, "C:/Users/gg/ws3");
    await mkdir(sessionDir, { recursive: true });
    const longText = "请" .repeat(60);
    await writeFile(
      join(sessionDir, "long.jsonl"),
      `{"type":"message","id":"m1","message":{"role":"user","content":"${longText}"}}\n`,
      "utf8",
    );
    const sessions = listWorkspaceSessions(dir, "C:/Users/gg/ws3");
    assert.equal(sessions[0]?.name.length, 41); // 40 + …
  });
});