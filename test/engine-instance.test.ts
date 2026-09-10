import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { EngineInstance } from "../src/main/engine-instance.ts";
import type { EngineExitInfo, EngineInstanceOptions, EngineProcess } from "../src/main/engine-instance.ts";
import {
  EngineRegistry,
  createEngineRegistry,
  normalizeWorkspaceKey,
} from "../src/main/engine-registry.ts";

/**
 * 协议模拟器：凡是收到命令就回一条 success:true 的响应，
 * 测试再按需要主动写 stdout（事件、坏响应、exit）。
 */
class FakeEngineProcess implements EngineProcess {
  readonly pid = 4321;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #events = new EventEmitter();
  readonly written: string[] = [];
  inputEnded = false;
  killed = false;
  treeKilled = false;
  /** 为 false 时，对任何命令都不回响应（用于启动探测超时等场景）。 */
  autoReply = true;
  /** 为 false 时，endInput 不会触发退出（用于测试 kill/killTree 兜底路径）。 */
  exitOnEndInput = true;

  write(record: string): void {
    this.written.push(record);
    if (!this.autoReply) return;
    const parsed = JSON.parse(record) as Record<string, unknown>;
    if (typeof parsed["type"] === "string") {
      const reply = {
        type: "response",
        id: parsed["id"],
        command: parsed["type"],
        success: true,
      };
      this.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  }

  endInput(): void {
    this.inputEnded = true;
    if (this.exitOnEndInput) {
      // 像真实的 pi 一样：stdin 结束时干净退出。
      setImmediate(() => this.emitExit(0));
    }
  }

  kill(): void {
    this.killed = true;
  }

  killTree(): void {
    this.treeKilled = true;
  }

  onStdout(listener: (chunk: string) => void): void {
    this.stdout.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
  }

  onStderr(listener: (chunk: string) => void): void {
    this.stderr.on("data", (chunk: Buffer) => listener(chunk.toString("utf8")));
  }

  onExit(listener: (info: EngineExitInfo) => void): void {
    this.#exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#events.on("error-event", listener);
  }

  emitError(error: Error): void {
    this.#events.emit("error-event", error);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const listener of this.#exitListeners) listener({ code, signal });
  }

  readonly #exitListeners: Array<(info: EngineExitInfo) => void> = [];
}

const WORKSPACE = "D:/work/ws";

function createEngine(overrides: {
  now?: () => number;
  idleTimeoutMs?: number;
  stopGraceMs?: number;
  probeTimeoutMs?: number;
  autoReply?: boolean;
  onStatusChange?: (status: string) => void;
  onWarning?: (error: Error) => void;
} = {}): { engine: EngineInstance; fake: FakeEngineProcess } {
  const fake = new FakeEngineProcess();
  if (overrides.autoReply !== undefined) fake.autoReply = overrides.autoReply;
  const starts: FakeEngineProcess[] = [];
  const options: Omit<EngineInstanceOptions, "workspace"> = {
    start: () => {
      starts.push(fake);
      return fake;
    },
    probeTimeoutMs: overrides.probeTimeoutMs ?? 2000,
    stopGraceMs: overrides.stopGraceMs ?? 50,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 1000,
    now: overrides.now ?? Date.now,
    ...(overrides.onStatusChange !== undefined ? { onStatusChange: overrides.onStatusChange } : {}),
    ...(overrides.onWarning !== undefined ? { onWarning: overrides.onWarning } : {}),
  };
  const engine = new EngineInstance({ ...options, workspace: WORKSPACE });
  return { engine, fake };
}

describe("EngineInstance", () => {
  it("start() 只 spawn 一次，探测通过后进入 ready，并透传事件", async () => {
    const statuses: string[] = [];
    const { engine, fake } = createEngine({ onStatusChange: (s) => statuses.push(s) });

    assert.equal(engine.status, "idle");
    await engine.start();
    assert.equal(engine.status, "ready");
    assert.equal(engine.pid, 4321);
    assert.deepEqual(statuses, ["starting", "ready"]);

    const written = fake.written.map((line) => JSON.parse(line) as Record<string, unknown>);
    const probe = written[0]!;
    assert.equal(probe["type"], "get_state");

    const events: unknown[] = [];
    engine.peer.onEvent((m) => events.push(m));
    fake.stdout.write('{"type":"agent_start"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.length, 1);

    await engine.stop();
  });

  it("启动探测超时 → 进入 crashed，并带上 stderr 尾部作为线索", async () => {
    const { engine, fake } = createEngine({ probeTimeoutMs: 40, autoReply: false, stopGraceMs: 20 });
    fake.stderr.write("RangeError: Cannot read properties of undefined");
    await assert.rejects(engine.start(), /引擎启动失败.*stderr/s);
    assert.equal(engine.status, "crashed");
  });

  it("退出码 0 → stopped；非零 → crashed；停止中退出 → stopped", async () => {
    const running = createEngine();
    await running.engine.start();
    running.fake.emitExit(0);
    assert.equal(running.engine.status, "stopped");

    const broken = createEngine();
    await broken.engine.start();
    broken.fake.emitExit(1);
    assert.equal(broken.engine.status, "crashed");

    const stopping = createEngine();
    await stopping.engine.start();
    const stoppingPromise = stopping.engine.stop();
    stopping.fake.emitExit(0);
    await stoppingPromise;
    assert.equal(stopping.engine.status, "stopped");
  });

  it("stop() 先结束 stdin 等退出，再 kill，最后 killTree", async () => {
    const { engine, fake } = createEngine({ stopGraceMs: 50 });
    await engine.start();
    await engine.stop();
    assert.equal(fake.inputEnded, true);
    assert.equal(fake.killed, false); // stdin 一关 fake 就退出了，不需要 kill

    const stubborn = createEngine({ stopGraceMs: 10 });
    stubborn.fake.exitOnEndInput = false; // 结束 stdin 也不退出
    await stubborn.engine.start();
    await stubborn.engine.stop(); // 从不 exit → 走 kill → killTree
    assert.equal(stubborn.fake.killed, true);
    assert.equal(stubborn.fake.treeKilled, true);
    assert.equal(stubborn.engine.status, "stopped");
  });

  it("stderr 累积成有界尾部，超长时截断", async () => {
    const { engine, fake } = createEngine();
    await engine.start(); // 监听器在 start() 里挂上
    fake.stderr.write("a".repeat(10_000));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(engine.stderrTail.length <= 8 * 1024);
    assert.equal(engine.stderrTail.endsWith("a".repeat(8192)), true);
    await engine.stop();
  });

  it("isIdle 只在 ready 状态且超过阈值时为真", async () => {
    let now = 1000;
    const { engine, fake } = createEngine({ now: () => now, idleTimeoutMs: 500 });
    assert.equal(engine.isIdle(), false); // idle 状态不算

    await engine.start();
    assert.equal(engine.isIdle(), false);
    now += 600;
    assert.equal(engine.isIdle(), true);
    fake.emitExit(0);
  });

  it("process error 事件 → crashed，并上报 onWarning", async () => {
    const warnings: Error[] = [];
    const { engine, fake } = createEngine({ onWarning: (e) => warnings.push(e) });
    await engine.start();
    fake.emitError(new Error("spawn ENOENT"));
    assert.equal(engine.status, "crashed");
    assert.equal(warnings.length, 1);
  });

  it("prompt() / abort() 完整走完 请求→响应 关联", async () => {
    const { engine, fake } = createEngine();
    await engine.start();
    const resolve = engine.prompt("跑一下测试");
    const written = fake.written.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(written.some((r) => r["type"] === "prompt" && r["message"] === "跑一下测试"), true);
    await resolve;
    await engine.abort();
    await engine.stop();
  });
});

describe("EngineRegistry", () => {
  it("同一 Workspace 复用同一实例（路径归一化），不同 Workspace 各自一个", () => {
    const registry = createEngineRegistry(() => ({ start: () => new FakeEngineProcess() }));
    const a = registry.get("D:/work/proj");
    const b = registry.get("D:/work/proj");
    const c = registry.get("D:/work/other");
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(registry.size, 2);
  });

  it("normalizeWorkspaceKey 对相对路径做 resolve", () => {
    assert.equal(normalizeWorkspaceKey("./a/b"), normalizeWorkspaceKey("a/b"));
  });

  it("ensureStarted 启动实例；reclaimIdle 只回收空闲的并从地图移除", async () => {
    let now = 0;
    const registry = new EngineRegistry({
      create: (workspace) =>
        new EngineInstance({
          workspace,
          start: () => new FakeEngineProcess(),
          now: () => now,
          idleTimeoutMs: 100,
          probeTimeoutMs: 500,
          stopGraceMs: 10,
        }),
    });
    const busy = await registry.ensureStarted("D:/busy");
    const lazy = registry.get("D:/lazy");
    await lazy.start();
    await new Promise((resolve) => setImmediate(resolve));

    // workspace 会被 resolve 成系统路径（Windows 上是反斜杠）
    const busyPath = resolve("D:/busy");
    const lazyPath = resolve("D:/lazy");

    // busy 有真实活动时间戳（还不够阈值）；把 now 推远，让两个都变空闲
    now = 1_000_000;
    await new Promise((resolve) => setImmediate(resolve));
    const reclaimed = await registry.reclaimIdle();
    assert.ok(reclaimed.includes(busyPath));
    assert.ok(reclaimed.includes(lazyPath));
    assert.equal(registry.getExisting("D:/busy"), undefined);
    assert.equal(registry.getExisting("D:/lazy"), undefined);
    assert.equal(registry.size, 0);
    assert.equal(registry.runningWorkspaces().length, 0);
    void busy;
  });

  it("runningWorkspaces 只列已启动的", async () => {
    const registry = createEngineRegistry(() => ({
      start: () => new FakeEngineProcess(),
    }));
    await registry.ensureStarted("D:/on");
    registry.get("D:/off"); // 只创建，不启动
    const running = registry.runningWorkspaces();
    assert.deepEqual(running, [resolve("D:/on")]);
    await registry.stopAll();
    assert.equal(registry.size, 0);
  });
});