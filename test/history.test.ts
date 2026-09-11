import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapMessagesToItems } from "../src/renderer/src/history.ts";

describe("mapMessagesToItems", () => {
  it("用户消息 → user 条目，带 entryId", () => {
    const items = mapMessagesToItems([
      { type: "user", id: "e1", message: { role: "user", content: "修复登录页" } },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "user");
    assert.equal(items[0]?.entryId, "e1");
    assert.equal(items[0]?.text, "修复登录页");
  });

  it("助手消息：文本与 tool_use 拆成独立条目", () => {
    const items = mapMessagesToItems([
      {
        type: "assistant",
        id: "e2",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "开始修改" },
            { type: "tool_use", id: "c1", name: "edit", input: { path: "src/x.ts", edits: [] } },
            { type: "text", text: "改完了" },
          ],
        },
      },
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["assistant", "tool", "assistant"],
    );
    const tool = items[1]!;
    assert.equal(tool.title, "edit");
    assert.equal(tool.state, "完成");
    assert.ok(tool.args?.includes('"path"'));
  });

  it("content 为字符串的用户消息也能解析", () => {
    const items = mapMessagesToItems([
      { type: "user", id: "e3", message: { role: "user", content: "直接字符串" } },
    ]);
    assert.equal(items[0]?.text, "直接字符串");
  });

  it("tool_result 不单独渲染；空输入返回空数组", () => {
    const items = mapMessagesToItems([
      { type: "tool_result", id: "r1", toolUseId: "c1", content: [] },
    ]);
    assert.equal(items.length, 0);
    assert.deepEqual(mapMessagesToItems([]), []);
  });
});