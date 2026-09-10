# 权限边界是 Workspace 工具白名单，不做危险命令拦截

Status: accepted

pi 没有内置沙箱，`docs/security.md` 明确说明 project trust 只是「是否加载项目资源」的加载闸门、不是沙箱，工具边界靠白名单（`tools` / `--tools` / `--no-tools` / `--exclude-tools` / `defaultTools`）。因此本项目的安全面只有两件事：**把真实执行过程透明地摊在用户面前**，以及**给用户一个他能理解的真实边界** —— 按 Workspace 配置的工具白名单。我们明确不做「匹配危险命令就弹确认」这类拦截。

## Considered Options

- **危险命令确认框**（正则匹配 `rm -rf`、`git push`、`npm publish`、`curl … | sh`）。否决：它挡不住真正危险的东西（混淆脚本、被 prompt injection 驱动的 push、`curl … | sh` 的变体），却会让非技术用户以为「危险的东西已经被挡住了」。`docs/security.md` 已经论证过「部分沙箱容易被误解为安全边界」是本项目最该避免的错误，一个正则拦截框是同一类错误的界面版本。
- **默认全开 + 只做展示**。否决：非终端用户需要一个可操作的边界，而不是只有可见性。
- **容器/沙箱化**。否决给 v1：它是上游文档给出的正确隔离手段，但它要求每个 Workspace 有镜像或微虚拟机，对「打开一个目录就能用」的前提是致命的复杂度。留作后续能力，并且在界面里明确告知 pi 没有沙箱。

## Consequences

- 新 Workspace 默认允许 `read`、`write`、`edit`，**禁用 `bash`**；用户第一次需要时展示解释性卡片让他为该 Workspace 开启，而不是在首次启动时用一堆复选框做安全表演。
- 白名单按 Workspace 持久化，写入 pi 的 settings 体系（走管理面，见 ADR-0002）。
- 界面必须如实说明「开启 shell 后 agent 可以在该目录内运行任何命令，包括联网」，并且不得出现任何暗示存在沙箱的措辞。
- `--mode rpc` 不显示 project trust 提示，信任决策由 GUI 承载（读写 `~/.pi/agent/trust.json` 或用 `--approve` 覆盖单次运行）。
- prompt injection 无法被本项目阻止：仓库文件、注释、构建输出都可能驱动 agent。这一点必须写在产品文案里，而不是只写在仓库文档里。
