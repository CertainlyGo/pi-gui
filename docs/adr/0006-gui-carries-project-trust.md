# 项目信任的决策由 GUI 承载，且不允许默认信任

Status: accepted

`pi --mode rpc` 不显示信任提示：它按 `defaultProjectTrust` 处理，而该值默认是 `"ask"`，在非交互模式下的语义是**静默忽略**项目级资源。GUI 若不处理，用户打开一个带 `.pi/settings.json` 或 `.pi/extensions/` 的仓库时，那些资源不会加载，而用户不会收到任何提示。我们选择由 GUI 实现信任卡片：检测到需要信任的资源时，**逐条列出发现了什么**，让用户选择信任此目录或不信任，并把决策写进 pi 自己的 `~/.pi/agent/trust.json`（按 canonical 目录记录，父目录决策对子目录生效，设置里可撤销），不写 `defaultProjectTrust: "always"`。

需要信任的资源由 pi 定义：`.pi/settings.json`、`.pi/extensions|skills|prompts|themes`、`.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md`，以及当前或祖先目录中的项目 `.agents/skills`。只有一个空的 `.pi` 目录不算。

## Considered Options

- **永远不信任**（相当于永远传 `--no-approve`）：安全，但用户从终端里信任过的项目在 GUI 里会突然失效，两个前端行为不一致。
- **默认信任**（写 `defaultProjectTrust: "always"`）：否决。一个从 GitHub clone 下来的仓库带着 `.pi/extensions/x.ts` 就能在用户第一次打开目录时执行代码，而非终端用户没有能力审查那段代码 —— 这正是 project trust 存在的理由。
- **GUI 自己另存一套信任状态**：否决。会与终端里运行的 pi 产生分叉，用户在一边信任过、另一边还要再信一次。

## Consequences

- GUI 必须自己实现资源探测，并与 pi 的规则保持一致。上游改动这条规则时我们不会自动跟上，这是需要定期核对的耦合点。
- 信任未决时的界面必须**如实说明项目资源当前未加载**，而不是安静地少加载一些东西。
- 单次运行覆盖仍可用 `--approve` / `--no-approve`；GUI 在「仅这一次」场景下使用它们，不写 `trust.json`。
- 信任只影响资源加载，不影响工具能做什么 —— 后者是 Workspace 工具白名单（ADR-0003）。界面上这两件事必须分开表述，不能让用户以为「信任了这个目录」等于「限制了什么」。
