import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { describe, it } from "node:test";
import { createTrustStore, detectTrustResources } from "../src/main/trust.ts";

const dir = await mkdtemp(join(tmpdir(), "pi-gui-trust-"));
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectTrustResources", () => {
  it("空目录 → 无本地资源（祖先目录的 .agents/skills 可能命中，那是真实语义）", async () => {
    const empty = join(dir, "empty");
    await mkdir(empty, { recursive: true });
    const found = detectTrustResources(empty);
    assert.equal(found.every((label) => !label.startsWith(".pi/")), true);
  });

  it("识别 .pi/settings.json 与 .pi/extensions/", async () => {
    const project = join(dir, "project");
    await mkdir(join(project, ".pi", "extensions"), { recursive: true });
    await writeFile(join(project, ".pi", "settings.json"), "{}", "utf8");
    const found = detectTrustResources(project);
    assert.ok(found.includes(".pi/settings.json"));
    assert.ok(found.includes(".pi/extensions/"));
    assert.equal(found.includes(".pi/SYSTEM.md"), false);
  });

  it("识别祖先目录里的项目 .agents/skills，并注明位置", async () => {
    const outer = join(dir, "outer");
    const inner = join(outer, "inner");
    await mkdir(join(outer, ".agents", "skills"), { recursive: true });
    await mkdir(inner, { recursive: true });
    const found = detectTrustResources(inner);
    assert.ok(found.some((label) => label.includes(".agents/skills") && label.includes("位于")));
  });

  it("当前目录的 .agents/skills 标注为项目资源", async () => {
    const project = join(dir, "own");
    await mkdir(join(project, ".agents", "skills"), { recursive: true });
    const found = detectTrustResources(project);
    assert.ok(found.includes("项目 .agents/skills"));
  });
});

describe("createTrustStore", () => {
  it("决策写入 pi 自己的 trust.json，重复读取一致", () => {
    const store = createTrustStore(join(dir, ".pi"));
    const cwd = join(dir, "trust-me");
    assert.equal(store.decision(cwd), "ask"); // 未决定
    store.decide(cwd, "always");
    assert.equal(store.decision(cwd), "always");
    store.decide(cwd, "never");
    assert.equal(store.decision(cwd), "never");
  });
});