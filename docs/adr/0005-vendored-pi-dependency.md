# pi 作为 GUI 自己的依赖分发，更新由 GUI 负责

Status: accepted

pi 本体不从用户系统里找，而是作为 `pi-gui` 的 npm 依赖装进自己的 `node_modules`，用 Electron 内置的 Node 以 `ELECTRON_RUN_AS_NODE` 模式运行 `@earendil-works/pi-coding-agent/dist/bundle/cli.js --mode rpc`。用户因此不需要装 Node、npm 或 pi 本身。

**这修正了 Round 3 第 5 问的说法**：那里说「pi 本体的更新委托给 pi 自己的机制」，在 vendored 模式下不成立 —— `pi update --self` 更新的是系统里那份 CLI 安装，不是我们依赖树里这一份。正确表述是：**GUI 自己的更新流程负责升级 pi 依赖，升级后重启 Engine 生效**。pi 自己的 staged release 机制与 GUI 无关。

## Considered Options

- **要求用户系统里已有全局 `pi`**：违背「给不愿意用终端的用户」这个产品前提 —— 装 npm 全局包本身就是终端操作。
- **首次启动时用官方安装脚本装一份到系统**：要写用户系统、要处理下载失败与权限，收益为零，且会和用户已有的 pi 安装打架。
- **把 pi 的发布产物 vendored 进安装包但不走 npm 依赖**：失去 `npm-shrinkwrap.json` 带来的完整依赖钉死，升级变成手工活。

## Consequences

- 用户机器上可能同时存在两份 pi：GUI 跑的这份，和他自己终端里的那份。它们共享 `~/.pi/agent/` 下的 settings、sessions、auth、trust 与 npm 包目录，因此 **升级 pi 依赖前要确认它仍能读写当前 `~/.pi/agent` 状态**，否则会出现 GUI 打不开旧 session 的情况。
- 发布包的 `files` 字段排除了 `dist/experimental`、`dist/cli/experimental` 与 `dist/client`，所以实验性 Chord 那条路对 npm 依赖形态的我们根本不可用。这从另一侧佐证了 ADR-0001 否决它的判断。
- 升级 pi = 换依赖版本 + 重启 Engine 子进程；如果那个 session 正在运行，必须等它空闲或显式打断，不能热替换。
- GUI 自己的更新（Electron 标准流程）与 pi 依赖的升级是两件事，界面要能分别表达「pi-gui 有新版本」和「引擎组件有新版本」。
