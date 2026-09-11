# 开发笔记

## 命令

```bash
npm run typecheck      # tsc --noEmit（erasable TS，strict，无 emit）
npm test               # node --test test/*.test.ts
npm run smoke:engine   # 用真实 pi 走 启动→探测→get_state→停止
```

## 已验证的环境事实（2026-09）

- **pi 版本钉在 0.85.1**（`@earendil-works/pi-coding-agent`），`engines.node >= 22.19.0`。
- **Electron 内置 Node 版本下限**：E35/36 = Node 22.14，E37 = 22.16，**E42 起 = 24.19/24.20**。选 Electron 必须 ≥ 42，并在升级时核对（ADR-0004 有自动检查要求）。
- 本机 npm registry 可达；**github.com 被 hosts 屏蔽（Steam++）**。Electron 二进制安装必须走镜像：

  ```bash
  # Windows PowerShell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  npm install electron
  ```

- pi 发布包的 `files` 排除了 `dist/experimental`、`dist/cli/experimental`、`dist/client`，npm 用户拿不到实验性 Chord 路线（ADR-0001/0005 佐证）。
- `get_state` 的响应体形如 `{id, type:"response", command, success, data}`，状态在 `data` 里。

## 测试约定

- 核心层（分帧、RPC peer、Engine 监督）零依赖，用本机 Node 24 直接跑（type stripping），不需要 Electron。
- FakeEngineProcess 是协议模拟器：收到命令回 success 响应，endInput 时干净退出（可配置自动回复/退出）。
- posix 一个注意点：`EngineProcess.killTree()` 依赖 `detached` 进程组，Windows 走 `taskkill /T /F`。

## Electron 壳的坑（都踩过）

- **preload 必须是 CJS**：`sandbox: true` 的 preload 不支持 ESM。electron-vite 5 默认输出 `.mjs`，需要在 preload 配置里强制 `output: { format: "cjs", entryFileNames: "index.js" }`。
- **主进程里取 vendored pi 的路径用 `import.meta.resolve`，不能用 `require.resolve`**：pi 包的 exports 只声明了 `"import"` 条件，没有 `"require"`，CJS require 会在加载阶段直接抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- dev 三连：`npx electron-vite dev`（渲染层 HMR + 重启 main 自动重载）；验证 boot 用 PowerShell `Start-Process` + `taskkill /T /F` 收进程树，别用 `/IM electron.exe`（会误杀 VS Code）。
- CSP 在开发模式不收紧（vite HMR 需要内联脚本），生产构建时再锁，见 index.html 注释。
- React/TS 版本注意：本机 npm 的 `typescript` 是 7.x（原生编译器），`@types/node` 配 24.x，`erasableSyntaxOnly` 约束仍生效。
- **OAuth 登录复用 pi 的内部实现**：`@earendil-works/pi-ai` 的公开导出只有 OAuth 类型，PKCE 流程实现（`dist/auth/oauth/load.js` 及各 provider 模块）通过**绝对文件路径深 import** 加载（规避 exports map）。路径随版本钉死（ADR-0005），升级 pi 版本时必须回归验证 `loadOAuthAuth`。