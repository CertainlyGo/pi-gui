import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { EngineExitInfo, EngineProcess } from "./engine-instance.ts";

export interface SpawnPiEngineOptions {
  /** 引擎子进程的 cwd，也就是 Workspace。 */
  readonly workspace: string;
  /** 跑引擎的 Node/Electron 二进制。Electron 里是 process.execPath。 */
  readonly nodeExecPath: string;
  /** pi CLI 的 JS 入口：node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js */
  readonly cliPath: string;
  readonly extraArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * 用 Electron 内置的 Node（`ELECTRON_RUN_AS_NODE`）拉起 pi 的 RPC 模式
 * （ADR-0005：pi 是 vendored 依赖，不从系统里找）。
 *
 * POSIX 上 `detached: true` 让子进程自成进程组，killTree 才能用 `kill(-pid)`
 * 连根端掉；子进程不会随宿主退出而消亡这一点，由 EngineInstance/应用层负责
 * 在退出时显式 stopAll。
 */
export function spawnPiEngine(options: SpawnPiEngineOptions): EngineProcess {
  const args = [options.cliPath, "--mode", "rpc", ...(options.extraArgs ?? [])];
  const child = spawn(options.nodeExecPath, args, {
    cwd: options.workspace,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...options.env },
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  return new ChildProcessAdapter(child);
}

class ChildProcessAdapter implements EngineProcess {
  readonly pid: number | undefined;
  readonly #child: ChildProcess;
  readonly #stdoutDecoder = new StringDecoder("utf8");
  readonly #stderrDecoder = new StringDecoder("utf8");

  constructor(child: ChildProcess) {
    this.#child = child;
    this.pid = child.pid;
    if (child.stdout === null || child.stderr === null || child.stdin === null) {
      throw new Error("子进程没有打开标准流（stdio 配置错误）");
    }
    const stdout = child.stdout;
    const stderr = child.stderr;
    this.#stdin = child.stdin;
    stdout.on("data", (chunk: Buffer) => {
      for (const listener of this.#stdoutListeners) {
        listener(this.#stdoutDecoder.write(chunk));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const listener of this.#stderrListeners) {
        listener(this.#stderrDecoder.write(chunk));
      }
    });
    child.on("exit", (code, signal) => {
      for (const listener of this.#exitListeners) listener({ code, signal });
    });
    child.on("error", (error) => {
      for (const listener of this.#errorListeners) listener(error);
    });
  }

  write(record: string): void {
    this.#stdin.write(record);
  }

  endInput(): void {
    this.#stdin.end();
  }

  kill(): void {
    this.#child.kill();
  }

  killTree(): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    if (process.platform === "win32") {
      void spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // 进程组可能已经没了（比如在 killTree 之前自己退出了）。
      }
    }
  }

  onStdout(listener: (chunk: string) => void): void {
    this.#stdoutListeners.push(listener);
  }

  onStderr(listener: (chunk: string) => void): void {
    this.#stderrListeners.push(listener);
  }

  onExit(listener: (info: EngineExitInfo) => void): void {
    this.#exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.#errorListeners.push(listener);
  }

  readonly #stdin: NodeJS.WritableStream;
  readonly #stdoutListeners: Array<(chunk: string) => void> = [];
  readonly #stderrListeners: Array<(chunk: string) => void> = [];
  readonly #exitListeners: Array<(info: EngineExitInfo) => void> = [];
  readonly #errorListeners: Array<(error: Error) => void> = [];
}