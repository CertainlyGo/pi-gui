# 管理面用进程内 SDK 导入，而不是直接读写 pi 的文件

Status: accepted

RPC 协议不覆盖登录、session 列表与发现、Package 安装/更新、`settings.json` 与 `trust.json` 读写，所以 GUI 必须自建一层管理面。我们选择在 Electron 主进程里直接 import `@earendil-works/pi-coding-agent` 的 SDK（`SessionManager` 列出与恢复 session、`ModelRuntime` 列模型、auth 与设置模块写凭据和配置），而 agent 循环仍走 RPC 子进程。管理面因此与引擎分离：一个负责配置与目录，一个负责执行。

## Considered Options

- **直接读写 pi 的文件**（`settings.json`、`auth.json`、`trust.json`、sessions 目录、`~/.pi/agent/npm/`）。否决：这要求重写 npm 安装语义、settings schema 与 trust 判定 —— 包括 `npm:` 与 `git:` 源的差别、`-l` 项目级与用户级设置的差别、pinned 版本要跳过更新、项目级包在启动时自动补齐。这是上游最容易变化的部分，复制一份没人会维护。只读展示允许直接读文件。
- **全部 shell out 到 `pi` CLI**（`pi install`、`pi list`、`pi update`）。否决作为主路径：CLI 输出是终端展示文本，被文档定义为机器接口的是 RPC 与 SDK。保留作为个别能力的逃生通道。
- **把管理面也塞进 RPC**。否决：协议由上游拥有，我们无法为登录和包管理扩展它。

## Consequences

- **会出现进程内 SDK 与 RPC 子进程同时访问同一批文件**。管理面的写操作必须串行化，禁止在 session 运行中重写 `settings.json`；引擎需要重新读取配置时，先用 RPC 的 reload 类能力通知引擎，再落盘。
- `./client` 子导出指向 `src/` 源码而非 `dist/`，外部打包需要自己处理这一条。
- GUI 的登录能力受 SDK 导出的 auth 接口限制；若上游未导出某个 OAuth 流程，v1 就只能做粘贴 API Key 与 Radius（与已定范围一致）。
- 管理面与引擎共用 `~/.pi/agent/` 下的状态，因此 GUI 与终端里运行的 pi 会互相看到对方的改动。这是特性，但要求界面不要缓存太久。

## 修正（2026-09）：`auth.json` 的窄例外

SDK 根导出**没有**凭据写入器，`pi` CLI 也没有写凭据的命令（TUI 的 `/login` 是唯一官方写入路径，GUI 无法使用）。因此写入 `~/.pi/agent/auth.json` 成为管理面里唯一的直接文件写入，并被收紧到：只碰这一个文件；schema 严格照 `docs/providers.md` 的 `{ type, key }` 格式；每次写入后必须用 `pi auth check --json` 验证结果并展示给用户；文件不是合法 JSON 时**拒绝写入**而不是静默重建；只合并目标 provider，不动其它条目。实现见 `src/main/credentials.ts`。
