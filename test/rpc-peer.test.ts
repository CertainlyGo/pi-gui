import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  RpcCommandError,
  RpcPeer,
  isDialogUiMethod,
  isExtensionUiRequest,
} from "../src/shared/rpc-peer.ts";

function createPeer(overrides: { newId?: () => string } = {}): {
  peer: RpcPeer;
  sent: string[];
} {
  const sent: string[] = [];
  const peer = new RpcPeer({
    send: (record) => sent.push(record),
    newId: overrides.newId ?? (() => `id-${sent.length + 1}`),
  });
  return { peer, sent };
}

function parseSent(sent: readonly string[]): Array<Record<string, unknown>> {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("RpcPeer", () => {
  it("request 带上生成的 id，并能按 id 关联到响应", async () => {
    const { peer, sent } = createPeer();
    const promise = peer.request({ type: "get_state" });
    const written = parseSent(sent)[0]!;
    assert.equal(written["type"], "get_state");
    assert.equal(typeof written["id"], "string");

    peer.handleMessage({
      type: "response",
      id: written["id"],
      command: "get_state",
      success: true,
      state: { running: true },
    });
    const response = await promise;
    assert.equal(
      (response["state"] as Record<string, unknown> | undefined)?.["running"],
      true,
    );
    assert.equal(peer.pendingCount, 0);
  });

  it("success:false 变成携带命令名与错误文本的 RpcCommandError", async () => {
    const { peer, sent } = createPeer();
    const promise = peer.request({ type: "set_model", model: "nope" });
    const id = parseSent(sent)[0]!["id"];
    peer.handleMessage({
      type: "response",
      id,
      command: "set_model",
      success: false,
      error: "Model not found: nope",
    });
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof RpcCommandError);
      assert.equal(error.command, "set_model");
      assert.match(error.message, /Model not found/);
      return true;
    });
  });

  it("没有相同 id 的迟到响应被安静丢弃", () => {
    const { peer } = createPeer();
    assert.doesNotThrow(() => {
      peer.handleMessage({ type: "response", id: "nobody-waiting", success: true });
    });
  });

  it("事件与扩展 UI 请求分走不同的监听器", () => {
    const { peer } = createPeer();
    const events: unknown[] = [];
    const uiRequests: unknown[] = [];
    peer.onEvent((message) => events.push(message));
    peer.onExtensionUiRequest((request) => uiRequests.push(request));

    peer.handleMessage({ type: "agent_start" });
    peer.handleMessage({
      type: "extension_ui_request",
      id: "u-1",
      method: "confirm",
      title: "Clear session?",
    });
    peer.handleMessage({ type: "message_update", text: "hi" });

    assert.equal(events.length, 2);
    assert.equal(uiRequests.length, 1);
    assert.equal(isExtensionUiRequest(uiRequests[0]), true);
  });

  it("respondToExtensionUi 以携带原 id 的 extension_ui_response 回话", () => {
    const { peer, sent } = createPeer();
    peer.respondToExtensionUi({ type: "extension_ui_response", id: "u-1", confirmed: true });
    const written = parseSent(sent)[0]!;
    assert.equal(written["type"], "extension_ui_response");
    assert.equal(written["id"], "u-1");
    assert.equal(written["confirmed"], true);
  });

  it("notify 不带 id（纯通知）", () => {
    const { peer, sent } = createPeer();
    peer.notify({ type: "whatever", payload: 1 });
    const written = parseSent(sent)[0]!;
    assert.equal(written["id"], undefined);
  });

  it("dispose 会把在途请求全部拒绝", async () => {
    const { peer, sent } = createPeer();
    const promise = peer.request({ type: "get_state" });
    const id = parseSent(sent)[0]!["id"] as string;
    peer.dispose("引擎没了");
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof RpcCommandError);
      assert.match(error.message, /引擎没了/);
      return true;
    });
    assert.equal(peer.pendingCount, 0);
    // 停止后再发请求会立刻拒绝
    await assert.rejects(peer.request({ type: "get_state" }), RpcCommandError);
  });

  it("per-request 超时到期会拒绝并清空在途请求", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { peer, sent } = createPeer();
      const promise = peer.request({ type: "get_state" }, { timeoutMs: 100 });
      const id = parseSent(sent)[0]!["id"] as string;
      assert.equal(peer.pendingCount, 1);
      mock.timers.tick(101);
      await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof RpcCommandError);
        assert.match(error.message, /超时/);
        return true;
      });
      assert.equal(peer.pendingCount, 0);
      // 迟到的响应此时无人等待，会被丢弃
      assert.doesNotThrow(() =>
        peer.handleMessage({ type: "response", id, success: true }),
      );
    } finally {
      mock.timers.reset();
    }
  });

  it("isDialogUiMethod 只认四种对话框方法", () => {
    assert.equal(isDialogUiMethod("confirm"), true);
    assert.equal(isDialogUiMethod("editor"), true);
    assert.equal(isDialogUiMethod("notify"), false);
    assert.equal(isDialogUiMethod("setStatus"), false);
  });
});