import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JsonlDecoder, RpcFrameError, encodeRecord } from "../src/shared/rpc-frames.ts";

describe("encodeRecord", () => {
  it("输出恰好一条以 LF 结尾的记录", () => {
    const line = encodeRecord({ type: "prompt", message: "你好" });
    assert.equal(line.endsWith("\n"), true);
    assert.equal(line.includes("\n"), true);
    assert.deepEqual(JSON.parse(line.slice(0, -1)), { type: "prompt", message: "你好" });
  });

  it("转义字符串里的 U+2028 / U+2029，防止被 Unicode 分隔符误切", () => {
    const line = encodeRecord({ type: "prompt", message: "a\u2028b\u2029c" });
    assert.equal(line.includes("\u2028"), false);
    assert.equal(line.includes("\u2029"), false);
    const parsed = JSON.parse(line.slice(0, -1)) as { message: string };
    assert.equal(parsed.message, "a\u2028b\u2029c");
  });

  it("不可序列化的值抛 RpcFrameError", () => {
    assert.throws(() => encodeRecord(undefined), RpcFrameError);
    assert.throws(() => encodeRecord(() => 1), RpcFrameError);
  });
});

describe("JsonlDecoder", () => {
  it("一个 chunk 里把多条记录解出来", () => {
    const decoder = new JsonlDecoder();
    const outcome = decoder.push('{"a":1}\n{"b":2}\n');
    assert.equal(outcome.records.length, 2);
    assert.equal(outcome.errors.length, 0);
  });

  it("记录被切成两半也能还原", () => {
    const decoder = new JsonlDecoder();
    const first = decoder.push('{"a":');
    assert.equal(first.records.length, 0);
    assert.equal(decoder.bufferedLength, 5);
    const second = decoder.push('1}\n');
    assert.deepEqual(second.records, [{ a: 1 }]);
  });

  it("剥离行尾的 CR（接受 CRLF）", () => {
    const decoder = new JsonlDecoder();
    const outcome = decoder.push('{"a":1}\r\n');
    assert.deepEqual(outcome.records, [{ a: 1 }]);
  });

  it("字符串里的 U+2028 不是分隔符", () => {
    const decoder = new JsonlDecoder();
    const outcome = decoder.push('{"a":"x\u2028y"}\n');
    assert.equal(outcome.records.length, 1);
    assert.equal((outcome.records[0] as { a: string }).a, "x\u2028y");
  });

  it("坏记录报错但不中断流，后续记录照常解出", () => {
    const decoder = new JsonlDecoder();
    const tail1 = decoder.push('not-json\n{"ok":1}\n');
    assert.equal(tail1.errors.length, 1);
    assert.ok(tail1.errors[0] instanceof RpcFrameError);
    assert.deepEqual(tail1.records, [{ ok: 1 }]);
  });

  it("完整的超长记录被丢弃，后续记录照常解出", () => {
    const decoder = new JsonlDecoder({ maxRecordLength: 8 });
    const first = decoder.push('{"a":"12345678901234567890"}\n');
    assert.equal(first.errors.length, 1);
    assert.equal(first.records.length, 0);

    const second = decoder.push('{"ok":1}\n');
    assert.equal(second.errors.length, 0);
    assert.deepEqual(second.records, [{ ok: 1 }]);
  });

  it("残留缓冲区超限时报错并丢弃，直到下一个分隔符恢复", () => {
    const decoder = new JsonlDecoder({ maxRecordLength: 8 });
    // 一个没有结束的巨型记录：截断只发生在缓冲这一层。
    const first = decoder.push("0123456789");
    assert.equal(first.errors.length, 1);
    assert.equal(first.records.length, 0);
    assert.equal(decoder.bufferedLength, 0);

    const second = decoder.push("rest-of-record\n{\"ok\":1}\n");
    assert.equal(second.errors.length, 0);
    assert.deepEqual(second.records, [{ ok: 1 }]);
  });

  it("多余空行被容忍", () => {
    const decoder = new JsonlDecoder();
    const outcome = decoder.push("\n\n{\"a\":1}\n\n");
    assert.deepEqual(outcome.records, [{ a: 1 }]);
  });

  it("end() 把残留的不完整记录报成错误；干净缓冲区则无事", () => {
    const withTail = new JsonlDecoder();
    withTail.push('{"a":1}\n{"unfinished":');
    const ended = withTail.end();
    assert.equal(ended.errors.length, 1);

    const clean = new JsonlDecoder();
    clean.push('{"a":1}\n');
    assert.equal(clean.end().errors.length, 0);
  });
});