/**
 * 冒烟测试：用真实的本机 Node 拉起真实的 pi（vendored 依赖），
 * 走完 启动 → 探测 → get_state → 停止 这条最小链路。
 *
 * 验证的是 ADR-0005 的可行性：pi 的 cli.js 是纯 JS 入口，
 * 任何 ≥22.19 的 Node 都能跑，不需要系统里装 pi。
 *
 * 运行：npm run smoke:engine
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngineRegistry } from "../src/main/engine-registry.ts";
import { spawnPiEngine } from "../src/main/pi-process.ts";

const pkgEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const pkgRoot = dirname(dirname(pkgEntry));
const cliPath = join(pkgRoot, "dist", "bundle", "cli.js");

const workspace = await mkdtemp(join(tmpdir(), "pi-gui-smoke-"));
const registry = createEngineRegistry((ws) => ({
  start: () => spawnPiEngine({ workspace: ws, nodeExecPath: process.execPath as string, cliPath }),
  probeTimeoutMs: 30_000,
  stopGraceMs: 5_000,
}));

let failed = false;
try {
  console.log(`cli 入口: ${cliPath}`);
  const engine = await registry.ensureStarted(workspace);
  console.log(`状态=${engine.status} pid=${engine.pid}`);

  const state = await engine.getState();
  const keys = Object.keys(state).join(", ");
  console.log(`get_state 返回字段: ${keys || "(空)"}`);

  if (engine.status !== "ready") {
    console.error(`启动后状态不是 ready：${engine.status}`);
    failed = true;
  }
  if (typeof state["session"] !== "object" && state["session"] !== null) {
    console.log(`（注意：get_state 没有 session 字段，可按环境理解）`);
  }
} catch (error) {
  failed = true;
  console.error("冒烟失败：", error instanceof Error ? error.message : error);
} finally {
  await registry.stopAll();
  await rm(workspace, { recursive: true, force: true });
}

if (failed) process.exit(1);
console.log("冒烟通过：pi 以 vendored 依赖形式可被拉起并完成 RPC 往返。");