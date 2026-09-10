import { resolve } from "node:path";
import { EngineInstance } from "./engine-instance.ts";
import type { EngineInstanceOptions } from "./engine-instance.ts";

/**
 * Windows 上同一个目录可能以不同大小写出现，因此键统一归一化。
 * 这是「窗口 = 一个 Workspace」这条决定能成立的前提：同一个目录只能有一个引擎。
 */
export function normalizeWorkspaceKey(workspace: string): string {
  const absolute = resolve(workspace);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

export interface EngineRegistryOptions {
  /** 按 Workspace 造一个实例（不启动它）。 */
  readonly create: (workspace: string) => EngineInstance;
  readonly idleTimeoutMs?: number;
  readonly now?: () => number;
}

/**
 * 管理所有 Workspace 的 Engine 实例：懒启动、按 Workspace 唯一、空闲回收。
 *
 * 「关窗口」不在这里 —— 那是应用层策略；这里只提供 stopAll() 和 reclaimIdle()。
 */
export class EngineRegistry {
  readonly #instances = new Map<string, EngineInstance>();
  readonly #options: EngineRegistryOptions;
  readonly #now: () => number;

  constructor(options: EngineRegistryOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#instances.size;
  }

  /** 取（必要时创建）某个 Workspace 的实例，但不启动它。 */
  get(workspace: string): EngineInstance {
    const key = normalizeWorkspaceKey(workspace);
    const existing = this.#instances.get(key);
    if (existing !== undefined) return existing;
    const created = this.#options.create(resolve(workspace));
    this.#instances.set(key, created);
    return created;
  }

  getExisting(workspace: string): EngineInstance | undefined {
    return this.#instances.get(normalizeWorkspaceKey(workspace));
  }

  async ensureStarted(workspace: string): Promise<EngineInstance> {
    const instance = this.get(workspace);
    await instance.start();
    return instance;
  }

  /** 停止并移除所有空闲实例，返回被回收的 Workspace。 */
  async reclaimIdle(): Promise<readonly string[]> {
    const reclaimed: string[] = [];
    for (const [key, instance] of [...this.#instances]) {
      if (!instance.isIdle()) continue;
      await instance.stop();
      this.#instances.delete(key);
      reclaimed.push(instance.workspace);
    }
    return reclaimed;
  }

  /** 正在运行的 Workspace 列表，用于界面上标「运行中」。 */
  runningWorkspaces(): readonly string[] {
    const running: string[] = [];
    for (const instance of this.#instances.values()) {
      if (instance.status === "ready" || instance.status === "starting") {
        running.push(instance.workspace);
      }
    }
    return running;
  }

  async stopAll(): Promise<void> {
    const instances = [...this.#instances.values()];
    this.#instances.clear();
    await Promise.all(instances.map(async (instance) => instance.stop()));
  }
}

/** 便捷构造：把 EngineInstanceOptions 里按 Workspace 变化的部分留成工厂。 */
export function createEngineRegistry(
  createOptions: (workspace: string) => Omit<EngineInstanceOptions, "workspace">,
  registryOptions: Omit<EngineRegistryOptions, "create" | "now"> = {},
): EngineRegistry {
  return new EngineRegistry({
    ...registryOptions,
    create: (workspace) => new EngineInstance({ ...createOptions(workspace), workspace }),
  });
}
