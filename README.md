# pi-gui

pi 的图形前端 —— 给不愿意使用终端的用户一个窗口来驱动本地 coding agent。

引擎跑的是 pi 本体（`--mode rpc` 子进程），本仓库**只做界面与管理面，不自己实现 agent 循环**。用户不需要碰命令行：选工作区 → 决定是否信任 → 说话。

## 特性

- **会话管理**
  - 会话用第一条问题自动命名（老会话在列表里也显示首条问题文本）
  - 重开窗口自动恢复最近会话，历史消息完整保留
  - 新建 / 删除（两步确认）/ 切换（带入场动画，当前会话置顶高亮）
  - 在任意历史用户消息上「从这里分支」，进入子会话（pi 的 fork 语义）
- **模型与思考等级**：按供应商分组切换，未配置凭据的供应商有「到账号页配置」引导
- **账号**
  - OAuth 订阅登录：Codex / Claude Pro / Max / GitHub Copilot / Grok / OpenRouter / Kimi / Radius（复用 pi 自己的 PKCE 流程）
  - API Key：OpenAI 兼容 / Anthropic 兼容两种格式，可填自定义 API 网址（base URL）+ Key，保存后用 `pi auth check` 验证
- **实时统计条**：输入 / 输出 token、缓存命中率、上下文占用条、吐字速度、费用
- **工具调用卡片**：可展开参数与输出；edit 类工具渲染行级彩色 diff，write 显示写入内容
- **插件市场**：npm `pi-package` 关键字搜索 + 安装 / 更新 / 移除（全局或仅此工作区）
- **项目信任卡片**：打开工作区检测到 `.pi/*`、项目 `.agents/skills` 时先决定信任再启引擎
- **扩展对话框**：`select / confirm / input / editor` 原生渲染，头部标明第三方来源
- 明暗主题跟随系统

## 架构速览

决策的完整记录在 `docs/adr/`（6 份 ADR），术语表在 `CONTEXT.md`。

| 层 | 实现 | 依据 |
|---|---|---|
| 引擎 | vendored `@earendil-works/pi-coding-agent`；Electron 内置 Node 以 `ELECTRON_RUN_AS_NODE` 跑 `--mode rpc`，JSONL over stdin/stdout | ADR-0001, 0005 |
| 管理面 | 进程内 SDK（SessionManager / ProjectTrustStore）+ 窄 CLI 通道（`pi install` 等）；唯一直接写文件是 `auth.json`（严格按文档化 schema + 写入即验证）与 `models.json` 的 baseUrl 覆盖 | ADR-0002 |
| 安全 | 渲染层零 Node 能力（contextIsolation + sandbox preload），生产 CSP 收紧；网络能力全走主进程窄 IPC；权限边界 = Workspace 工具白名单 | ADR-0003, 0004 |
| 信任 | 决策写 pi 自己的 `trust.json`（走 SDK 的 `ProjectTrustStore`） | ADR-0006 |

## 开发

要求 Node ≥ 22.19（pi 的 `engines` 下限）。

```bash
# 安装（Electron 二进制走镜像；本机已屏蔽 github 直连时必用）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install

npm run dev          # 启动开发（主进程改代码会自动重启，渲染层 HMR）
npm run typecheck    # tsc --noEmit（strict + erasable TS）
npm test             # node:test（63 个用例，核心层零依赖可直跑）
npm run smoke:engine # 用真实 pi 走 启动→get_state→停止 往返
npm run build        # electron-vite 三端构建，产物在 out/

# 打包发行（Windows NSIS 安装包 → release/pi-gui-<version>-setup.exe）
# 本机需要两个环境变量（github 被屏蔽 + SSL 拦截，见 docs/development.md「打包发行」）：
#   $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
#   $env:NODE_OPTIONS="--use-system-ca"
npm run dist
```

从零到跑通：`npm run dev` → 右上角「账号」配置凭据 → 「选择工作区」→ 发消息。

踩过的坑（Electron/preload CJS、exports map、npm 镜像、OAuth 深 import 等）全部记在 [`docs/development.md`](docs/development.md)。

## 状态

活跃开发中。已产出 Windows 安装包（`release/pi-gui-0.1.0-setup.exe`，NSIS，选目录安装）；打包绕过的坑（asar 解包、目录 rename EPERM、证书/镜像）见 [`docs/development.md`](docs/development.md)。后续方向：恢复会话选择器、i18n 词表抽离、代码签名。