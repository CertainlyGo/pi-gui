# 技术栈用 Electron + React + TypeScript + Vite

Status: accepted

ADR-0001 要求主进程 spawn `pi --mode rpc` 子进程，ADR-0002 要求主进程 import pi 的 SDK（`SessionManager`、`ModelRuntime`、auth 与设置模块）。两者都需要宿主里有一个 Node 运行时，因此宿主只能是 Electron：Tauri 是 Rust 宿主，要满足这两条就得塞一个 Node sidecar，进程故事从两个变成三个；不使用 SDK 又会让管理面退回到 ADR-0002 否决过的方案。渲染层选 React + TypeScript + Vite，理由是界面 80% 的复杂度集中在长 transcript 的虚拟滚动、diff 渲染、代码高亮三块，这三块的现成件 React 生态最深。

## Considered Options

- **Tauri + Node sidecar**：安装包小、内存占用低，但多一个进程、多一层 sidecar 生命周期与打包，且 sidecar 里的 Node 与渲染层之间的桥要自己设计。
- **Tauri + 纯 Rust 管理面**：等于放弃 ADR-0002，自己实现 pi 的 session 目录、settings 与 npm 安装语义，与「共享逻辑只有一份实现」冲突。
- **本地 daemon + 浏览器前端**：需要一个安装服务、一个端口、一套认证，直接违反「打开就能用」的前提，也把一个本地工具的信任面扩大到网络。
- **原生（Swift/WinUI）**：每个平台一套 UI 代码，v1 只做 Windows 也不划算。

## Consequences

- **Electron 版本有下限**：pi 声明 `engines.node >= 22.19.0`，而我们要用 Electron 内置的 Node 跑它。选 Electron 版本前必须核对它内置的 Node 版本，并有自动化检查防止回退。
- 用 `ELECTRON_RUN_AS_NODE` 模式 spawn pi 的 `dist/bundle/cli.js`，而不是依赖系统里的 `pi` 命令。
- **渲染层必须按 Electron 的安全默认来**：`contextIsolation` 开、`nodeIntegration` 关，文件系统与子进程能力只通过 preload 暴露的窄 IPC 接口提供。这一条不是教条 —— 这个应用会把 agent 的原始输出（文件内容、命令输出、仓库里的任意文本）渲染到界面上，而渲染层一旦能直接 spawn，那么仓库内容里的一段注入文本就能升级成任意代码执行。
- 主进程需要自己管子进程树：Windows 上关闭 GUI 时必须连带结束 pi 子进程，否则会留下孤儿进程持有 session 写入权。
- 打包体积按百 MB 量级接受，换来的是自包含（不需要用户装 Node）。
