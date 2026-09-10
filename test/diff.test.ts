import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUnifiedDiff } from "../src/renderer/src/diff.ts";

const SAMPLE = [
  "diff --git a/src/pages/login.tsx b/src/pages/login.tsx",
  "index 1234567..89abcde 100644",
  "--- a/src/pages/login.tsx",
  "+++ b/src/pages/login.tsx",
  "@@ -10,3 +10,3 @@",
  " const form = useForm({",
  "-  validate: legacyValidate(schema),",
  "+  resolver: zodResolver(loginSchema),",
  " });",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("识别文件头 / hunk / add / del / ctx", () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    const kinds = parsed.rows.map((row) => row.kind);
    assert.deepEqual(kinds, ["file", "file", "file", "file", "hunk", "ctx", "del", "add", "ctx"]);
    assert.equal(parsed.additions, 1);
    assert.equal(parsed.deletions, 1);
  });

  it("add/del 行号从 hunk 头开始递增（ctx 只推进删除侧计数）", () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    const del = parsed.rows.find((row) => row.kind === "del");
    assert.equal(del?.lineNumber, 11);
    const add = parsed.rows.find((row) => row.kind === "add");
    assert.equal(add?.lineNumber, 10);
  });

  it("hunk 之外的正文被忽略；空 diff 不炸", () => {
    assert.equal(parseUnifiedDiff("").rows.length, 0);
    const noHunk = parseUnifiedDiff("some random text\nmore text\n");
    assert.equal(noHunk.rows.length, 0);
  });
});