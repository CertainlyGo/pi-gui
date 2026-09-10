# pi-gui

pi 的图形前端，给不愿意使用终端的用户一个窗口来驱动本地 coding agent。它复用 pi 本体作为引擎，自己不实现 agent 循环。

## Language

### 工作单位

**Workspace**:
用户用界面打开的一个本地目录，也是窗口所绑定的单位。Session 归属于一个 Workspace。
_Avoid_: Project, 目录, 仓库（repo 是 git 概念，Workspace 不一定是仓库）

**Session**:
pi 的持久化对话实体，可恢复、可命名、可分支成树。一个 Workspace 下可以有多个 Session。
_Avoid_: 聊天, 对话, 标签页, 线程

### 交互

**插话**:
会话运行中发送补充说明，Engine 会在当前回合的工具调用跑完后处理它。用于纠偏。
_Avoid_: steer, 打断, 干预, 中断

**排队**:
会话运行中发送消息，Engine 等当前回合完全结束后再处理。用于交代下一件事。
_Avoid_: follow_up, 队列, 待办, 稍后处理

### 分发

**Package**:
通过 npm、git 或本地路径分发，向 pi 贡献资源（extensions、skills、prompt templates、themes）的单元。用户从 `pi install` 或插件市场安装的就是它。
_Avoid_: Plugin, 插件, 扩展包, 模块

**Extension**:
Package 中可执行 TypeScript 代码的那类资源，与声明式的 skills、prompt templates、themes 相对。它和 pi 进程同权限运行。
_Avoid_: Plugin, 脚本, 工具

**Plugin**:
pi 实验性的 facet 插件（`src/experimental/plugins`），按 session / tui facet 贡献代码并支持热重载。它与 Package 不是同一事物，本项目不把它作为安装单位。
_Avoid_: 用「插件」同时指 Package 与 Plugin；用 Plugin 指代 Package

### 架构

**Engine**:
运行 agent 循环的进程。v1 中是 `pi --mode rpc` 子进程。
_Avoid_: 后端, server, 守护进程

**Engine 实例**:
一个绑定到单个 Workspace 的 Engine 子进程。它懒启动，空闲后回收；切换 Workspace 就是切换它。
_Avoid_: 会话进程, worker, 后台任务

**管理面**:
GUI 中负责配置与目录的部分 —— session 列表与恢复、登录与凭据、Package 安装与更新、settings 与 trust 读写。它不经由 Engine，与 Engine 是分离的两层。
_Avoid_: 后端, 服务端, 数据库

**Front end**:
同一个 Engine 之上的呈现层。TUI 是终端呈现层并保持上游权威；GUI 是本项目。
_Avoid_: UI, 客户端, app

### 安全

**信任决策**:
按目录记录的、是否允许 pi 加载该目录项目级资源（`.pi/settings.json`、`.pi/extensions`、项目 `.agents/skills` 等）的决定。它只影响资源是否加载，不影响工具能做什么。
_Avoid_: 授权, 权限, 沙箱

**Workspace 工具白名单**:
按 Workspace 配置的、允许 Engine 使用的工具集合，是本项目唯一真实的权限边界。
_Avoid_: 沙箱, 权限系统, 审批, 信任
