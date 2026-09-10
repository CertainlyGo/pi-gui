# 用 `pi --mode rpc` 子进程作为 agent 引擎

Status: accepted

GUI 需要在四种现成的接入方式里选一个来跑 agent：进程内 `AgentSession`、`pi --mode rpc` 子进程、实验性 Chord client/server、或直接调用底层 `pi-agent-core`。我们选择 **`pi --mode rpc` 子进程**：Electron 主进程 spawn 一个 pi 进程，用 JSONL over stdin/stdout 通信。原因是 agent 循环会被长工具调用卡住，也会有崩溃和死循环，把它放在自己进程里意味着 UI 不会跟着抖；同时 RPC 是官方文档点名给自定义 UI 的路径，覆盖 prompt / steer / follow_up / abort / 事件流 / 图片，还把 extension 的 dialog（select、confirm、input、editor）桥接成请求-响应子协议，让 GUI 能原生渲染扩展要的交互。实验性 Chord 路线是唯一支持「TUI 与 GUI 同时挂在同一个 Session 上」并将承载插件 facet 的方案，但它自称 experimental、无对端认证、无兼容性承诺，不能给非终端用户用。

## Considered Options

- **进程内 `AgentSession`**（`docs/sdk.md` 明确支持）：最省事，能直接调 `SessionManager`、auth 与模型运行时，没有序列化层。否决它作为 Engine 的理由是生命周期耦合：agent 与 UI 同生共死，且工具执行会占用 Electron 主进程。
- **实验性 Chord client/server**（`pi-protocol` v8 + `pi-client` + `pi-server`）：唯一提供多 presentation 挂载的路。否决给 v1 的理由是成熟度，不是设计。
- **直接调用 `pi-agent-core`**：等于自己实现 pi 的会话、资源加载、权限与工具编排，即复制一份上游逻辑，与「共享逻辑只有一份实现」的原则冲突。

## Consequences

- **登录、session 列表、插件安装、settings 读写都不在 RPC 协议里**，GUI 必须另建一层管理面来补齐。这层管理面可以走 SDK 进程内导入（`SessionManager`、`ModelRuntime`），但因此会出现「进程内 SDK 与 RPC 子进程同时读写同一批文件」的局面，写操作需要串行化。见后续 ADR。
- `--mode rpc` 按 `docs/security.md` 的规定**不显示 project trust 提示**，也不会自动加载未授信的项目资源。信任决策必须由 GUI 自己承载（读写 `~/.pi/agent/trust.json`，或用 `--approve` / `--no-approve` 覆盖单次运行）。
- 用户看到的不是完整的 pi 能力集合，而是 RPC 协议裁剪后的集合。任何 GUI 功能都要先回答「协议里有吗」，没有就得走管理面。
- Windows 上需要自己处理子进程树与打包（`pi` 二进制随 GUI 分发）。
