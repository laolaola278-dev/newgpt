<div align="center">

<img src="./docs/banner.png" alt="GPT++ — Local Coding Agent Runtime for ChatGPT Web" width="100%" />

<br />

<p>
  <a href="#实机运行展示"><strong>实机预览</strong></a> ·
  <a href="#全量本地能力矩阵"><strong>21 项工具矩阵</strong></a> ·
  <a href="#系统架构与信任边界"><strong>系统架构</strong></a> ·
  <a href="#双向线缆协议"><strong>协议规范</strong></a> ·
  <a href="#快速上手"><strong>快速上手</strong></a> ·
  <a href="#演进路线图"><strong>路线图</strong></a> ·
  <a href="#安全设计准则"><strong>安全准则</strong></a>
</p>

<p>
  <a href="https://github.com/laolaola278-dev/newgpt/actions/workflows/ci.yml"><img src="https://github.com/laolaola278-dev/newgpt/actions/workflows/ci.yml/badge.svg" alt="CI Status" /></a>
  <img src="https://img.shields.io/badge/Manifest-V3-0ea5e9?style=flat-square&labelColor=0f172a" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Extension-WXT_%2B_React_19-38bdf8?style=flat-square&labelColor=0f172a" alt="WXT + React 19" />
  <img src="https://img.shields.io/badge/Native_Host-Rust_(RPC_v1_%2B_MCP)-10b981?style=flat-square&labelColor=0f172a" alt="Rust Native Host" />
  <img src="https://img.shields.io/badge/Tests-121_TS_%2B_17_Rust-34d399?style=flat-square&labelColor=0f172a" alt="Tests Passing" />
  <img src="https://img.shields.io/badge/Privacy-100%25_On--Device-64748b?style=flat-square&labelColor=0f172a" alt="100% Local" />
</p>

</div>

---

## 设计初衷

**GPT++** 是一款专为 **ChatGPT Web (`chatgpt.com`)** 打造的 Chrome Manifest V3 扩展与 Rust 原生宿主桥接系统。

无需离开熟悉的 ChatGPT 网页界面，无需配置第三方 API Key，更不经过任何云端中转服务器——GPT++ 在浏览器隔离上下文与本机原生进程之间建立一条**强类型、工作区沙箱隔离、五域细粒度权限门控**的双向通道，让网页端模型直接连接本地 Agent Runtime（工作区文件系统、受控 Shell、原生 Git、纯本地项目记忆与 Skills、以及本地 MCP Server 生态），并将结构化执行结果自动回填至当前对话流实现多步自主闭环。

> **纯粹而克制的工程边界**：不是套壳 Web App，不是 SaaS 平台，无后端服务，无遥测上报，所有状态、项目记忆与权限配置 100% 留存在本机设备。

---

## 实机运行展示

### 1. 全局协同视图：ChatGPT Web × 五域交互式审批 × 实时运行面板

当访问 `chatgpt.com` 时，隔离在 Closed Shadow DOM 内的状态胶囊实时指示运行态；当模型请求写入工作区文件时，右侧 Side Panel 立即挂起运行流并弹出 **`APPROVAL REQUIRED · WRITE`** 交互卡片（支持 **`Allow Once`** 单次放行、**`Allow WRITE (Session)`** 当前会话授权或 **`Deny`** 拒绝）。

<p align="center">
  <img src="./docs/screenshots/hero-live-session.png" alt="GPT++ Full Live Session Workspace" width="100%" />
</p>

---

### 2. 对话流双向闭环：流式工具识别 → 原生进程调用 → 结果自动注入

模型在回复中输出严格受限的 `<gptpp:tool_call>` 协议块后，GPT++ 等待流式输出收敛，经 Schema 严格未知字段拦截、工作区路径边界校验与权限策略裁决后路由至 `com.gptpp.native` 原生宿主执行，并将 `[GPT++ TOOL RESULT]` 注入输入框自动提交。

<p align="center">
  <img src="./docs/screenshots/tool-loop-closeup.png" alt="Fenced Tool Call to Result Injection Close-Up" width="88%" />
</p>

---

### 3. Side Panel 双模态对照：交互式权限挂起 vs 多步闭环收敛

| 细粒度审批挂起态（`WAITING_PERMISSION` · 会话级授权与一键中断） | 多步 Git / FS 闭环完成态（5 域状态栏 · 本地 Skills · 21 项活跃工具） |
| :---: | :---: |
| <img src="./docs/screenshots/sidepanel-streaming.png" alt="Side Panel Interactive Consent State" width="100%" /> | <img src="./docs/screenshots/sidepanel-inspector.png" alt="Side Panel Completed State" width="100%" /> |

---

### 4. 控制中心（Options）：工作区沙箱边界 · 五域权限矩阵 · 本地 MCP 白名单

在扩展设置页中统一管控：**工作区根目录边界（Workspace Root）**、**五域默认策略矩阵（`READ` / `WRITE` / `EXECUTE` / `GIT` / `BROWSER`）**、**本地 stdio MCP Server 命令白名单**以及 **`com.gptpp.native` 宿主握手诊断**。

<p align="center">
  <img src="./docs/screenshots/options-confinement.png" alt="Workspace Confinement, 5-Scope Permissions & MCP Settings" width="88%" />
</p>

---

## 全量本地能力矩阵

所有工具均强制启用 `additionalProperties: false` 严格参数 Schema 校验；所有涉及本地路径的操作均经过 **Extension 侧归一化预检 + Rust 侧 `std::fs::canonicalize` 真实路径/符号链接逃逸拦截** 双重校验：

| 领域 | 工具名称 | 执行层 | 权限域 | 核心职责 |
| :--- | :--- | :---: | :---: | :--- |
| **Filesystem** | `fs_list_dir` | `native` (Rust) | `READ` | 列举工作区相对目录条目、类型（文件/目录/符号链接）与字节大小 |
| **Filesystem** | `fs_read_file` | `native` (Rust) | `READ` | 读取工作区内 UTF-8 文本文件（支持行号分页 `offset`/`limit` 与二进制拦截） |
| **Filesystem** | `fs_write_file` | `native` (Rust) | `WRITE` | 写入工作区内 UTF-8 文件并自动创建父目录（逐级核验真实祖先路径防逃逸） |
| **Filesystem** | `fs_search` | `native` (Rust) | `READ` | 在工作区源码树中高速检索子串并返回相对路径、行号与上下文预览 |
| **Shell** | `shell_exec` | `native` (Rust) | `EXECUTE` | 在工作区目录内执行受控命令（独立读写线程防管道死锁 + 墙钟超时强杀 + 字节上限） |
| **Native Git** | `git_status` | `native` (Rust) | `GIT` | 解析 `git status --porcelain=v1 --branch` 当前分支与变更文件列表 |
| **Native Git** | `git_diff` | `native` (Rust) | `GIT` | 获取工作树或暂存区（`--staged`）统一格式 Diff（`--` 隔离防参数注入） |
| **Native Git** | `git_log` | `native` (Rust) | `GIT` | 读取结构化近期提交历史（Commit Hash、作者、ISO 时间与标题） |
| **Native Git** | `git_stage` | `native` (Rust) | `GIT` | 将受工作区边界校验的文件路径显式暂存（`git add -- <paths>`） |
| **Native Git** | `git_commit` | `native` (Rust) | `GIT` | 使用无 Shell 插值的直接 `argv` 参数调用创建本地 Git 提交 |
| **Memory** | `memory_remember` | `local` (MV3) | `safe` | 按工作区隔离存储本地项目约定、架构决策与调试笔记（纯本机零上云） |
| **Memory** | `memory_recall` | `local` (MV3) | `safe` | 按关键词或标签检索当前工作区的本地持久化项目记忆 |
| **Memory** | `memory_forget` | `local` (MV3) | `safe` | 按键名清理过期的本地项目记忆条目 |
| **Skills** | `skill_list` | `local` (MV3) | `safe` | 列举内置（`/code-review`、`/bug-hunt`、`/commit-craft`）及自定义本地技能 |
| **Skills** | `skill_activate` | `local` (MV3) | `safe` | 加载指定本地 Skill 的完整标准作业剧本（亦可从 Side Panel 一键注入对话） |
| **MCP Bridge** | `mcp_list_servers` | `local` (MV3) | `safe` | 查询用户在 Options 白名单中配置的本地 MCP Server 列表与启停状态 |
| **MCP Bridge** | `mcp_list_tools` | `native` (Rust) | `EXECUTE` | 通过 stdio JSON-RPC (`2024-11-05`) 握手发现指定本地 MCP Server 暴露的工具 |
| **MCP Bridge** | `mcp_call_tool` | `native` (Rust) | `EXECUTE` | 调用白名单本地 MCP Server 工具（模型仅传 `serverId`，绝不接触底层启动命令） |
| **Browser** | `browser_list_tabs` | `local` (MV3) | `BROWSER` | 在 `BROWSER` 权限门控下查询当前打开标签页标题、激活状态与 URL |
| **Diagnostics** | `native_echo` / `demo_echo` | `native` / `local` | `safe` | 验证扩展内部管线及 Chrome Native Messaging ⇄ Rust 往返链路健康度 |

---

## 系统架构与信任边界

GPT++ 将整个运行链路严格划分为**四个权限递增的隔离区域**，确保不可信的网页 DOM 文本永远无法绕过校验直接触达系统能力：

<p align="center">
  <img src="./docs/architecture.png" alt="GPT++ Four-Boundary Architecture" width="100%" />
</p>

### 确定性 Agent 状态机

`AgentLoopController` 基于显式状态转移表驱动，任何非法跨态跃迁都会被 `AgentStateMachine` 立即拒绝，并在用户手动取消、发送新消息或切换 SPA 会话时平滑恢复：

```text
IDLE ──▶ OBSERVING ──▶ TOOL_DETECTED ──▶ WAITING_PERMISSION ──▶ EXECUTING
             ▲                                                      │
             └─────────── CONTINUING ◀──── INJECTING_RESULT ◀───────┘
```

---

## 双向线缆协议

### 1. 模型调用信封（Assistant → Extension）

```xml
<gptpp:tool_call id="call_git_01">
{"name":"git_status","arguments":{}}
</gptpp:tool_call>
```

### 2. 结果回填信封（Extension → ChatGPT Composer）

所有返回值与错误信息均自动经过长度截断保护与协议围栏清洗（防止嵌套标签逃逸注入）：

```text
[GPT++ TOOL RESULT]
tool: git_status
call_id: call_git_01

result:
{
  "branch": "main",
  "clean": false,
  "files": [{ "status": " M", "path": "src/parser.ts" }]
}

[/GPT++ TOOL RESULT]
```

### 3. Chrome Native Messaging & MCP Stdio 双层封帧

- **Service Worker ⇄ `com.gptpp.native`**：遵循 Chrome Native Messaging 标准二进制帧（`u32` 小端长度头 + UTF-8 JSON，单帧硬上限 `4 MiB`）。
- **`com.gptpp.native` ⇄ 本地 MCP Server**：由纯 Rust 标准库实现完整 Model Context Protocol `2024-11-05` 生命周期（`initialize` → `notifications/initialized` → `tools/list` & `tools/call`，作用域离开时 `Drop` 自动回收子进程防孤儿进程泄漏）。

---

## 快速上手

### 环境要求

- **Node.js** `>= 20` 与 **pnpm** `>= 10`
- **Rust 工具链**（`cargo` / `rustc` stable，用于编译 `native-host`）
- **Google Chrome** 或 **Chromium**（支持 Manifest V3 与 `sidePanel` API）

### 第一步：安装依赖与构建扩展

```bash
pnpm install      # 安装依赖并自动生成 WXT 类型配置
pnpm compile      # TypeScript 全量严格类型检查 (tsc --noEmit)
pnpm test         # 运行 121 项单元、权限门控、记忆隔离与 DOM 集成测试
pnpm build        # 构建生产包 → .output/chrome-mv3/
pnpm zip          # 打包发布归档 → .output/gpt-plus-plus-0.1.0-chrome.zip
```

### 第二步：在 Chrome 中加载扩展

1. 打开浏览器访问 `chrome://extensions`，开启右上角 **开发者模式 (Developer mode)**。
2. 点击 **加载已解压的扩展程序 (Load unpacked)**，选择仓库下的 `.output/chrome-mv3/` 目录。
3. 复制扩展卡片上生成的 **32 位扩展 ID**，并在扩展 **Options** 页面设置你的本地项目根目录（`Workspace Confinement Root`）。

### 第三步：编译并注册本地 Rust Native Host (`com.gptpp.native`)

```bash
# 运行 Rust 端全量单元与真实子进程集成测试（含沙箱逃逸、Git 生命周期与 MCP stdio 握手）
cargo test --manifest-path native-host/Cargo.toml --locked
```

**macOS / Linux 一键构建与注册：**

```bash
./scripts/install-native-host.sh <你的32位Chrome扩展ID>
```

**Windows (PowerShell，写入当前用户 HKCU 注册表，无需管理员权限)：**

```powershell
.\scripts\install-native-host.ps1 -ExtensionId <你的32位Chrome扩展ID>
```

---

## 工程目录蓝图

```text
gpt-plus-plus/
├── .github/workflows/ci.yml       # 双流水线 CI：MV3 扩展全量验证 + Rust 原生宿主编译与集成测试
├── entrypoints/
│   ├── background.ts              # MV3 Service Worker：五域权限网关、工作区预检、MCP 白名单解析与宿主桥接
│   ├── chatgpt.content.ts         # Content Script：DOM 适配器挂载、循环控制器与 Shadow DOM 状态胶囊
│   ├── sidepanel/                 # React 19 实时面板：交互式权限审批、五域状态栏、Skills 一键启动与工具枚举
│   └── options/                   # 控制中心：工作区根目录边界、五域策略矩阵、MCP Server 白名单与连接自检
├── lib/
│   ├── workspace.ts               # 跨平台工作区路径归一化与 ../ 前缀碰撞逃逸拦截器
│   ├── chatgpt/                   # 唯一允许访问页面 DOM 的适配层（多级回退选择器、流式状态机、会话识别）
│   ├── agent/
│   │   ├── loop/controller.ts     # Agent 核心状态机编排、历史防重放、交互式审批挂起、取消与恢复
│   │   ├── runtime.ts             # 纵深防御执行管线：信封校验 → 严格 Schema 校验 → 五域权限裁决 → 超时执行
│   │   ├── permission.ts          # PermissionManager：五域策略持久化、会话级授权 (Session Grant) 与等待队列
│   │   ├── memory/store.ts        # 按工作区隔离的纯本机项目记忆存储层 (chrome.storage.local)
│   │   ├── skills/store.ts        # 内置与自定义本地编码 Skills 仓库及协议引导提示词生成器
│   │   ├── mcp/store.ts           # 用户显式授权的本地 MCP Server 白名单存储层（防命令注入）
│   │   └── tools/                 # 21 项内置与原生工具定义 (fs / shell / git / memory / skills / mcp / browser)
│   └── native/                    # Chrome Native Messaging 客户端状态机、握手校验、帧编解码器
├── native-host/                   # 纯 Rust 原生宿主进程 (com.gptpp.native，仅依赖 serde + serde_json)
│   ├── manifest/                  # Chrome Native Messaging 清单模板
│   └── src/
│       ├── sandbox.rs             # canonicalize 真实路径沙箱守卫（拦截 ../ 越界与外部符号链接逃逸）
│       ├── dispatcher.rs          # RPC v1 握手与 13 项原生能力统一分发器
│       └── tools/                 # echo.rs / fs.rs / shell.rs / git.rs / mcp.rs 原生实现与集成测试
├── scripts/                       # macOS / Linux / Windows 免管理员原生宿主自动安装脚本与图标生成器
└── tests/                         # 17 个测试套件（121 项 TS 用例 + Rust 原生沙箱/Git/MCP 集成测试）
```

---

## 演进路线图

| 阶段 | 核心交付范围 | 当前状态 |
| :---: | :--- | :---: |
| **Phase 0** | WXT + React 19 + TypeScript + Tailwind v4 MV3 基础工程、Side Panel、Options 与测试基建 | ✅ 已完成 |
| **Phase 1** | `ChatGPTAdapter` 多回退选择器探测、流式输出状态机、SPA 路由追踪与输入框受控注入 | ✅ 已完成 |
| **Phase 2** | `<gptpp:tool_call>` 流式增量解析器、状态机循环守卫、权限握手框架与结果闭环回填 | ✅ 已完成 |
| **Phase 3** | Rust `gptpp-native` 原生宿主、Chrome Native Messaging 封帧协议、版本握手与双平台安装脚本 | ✅ 已完成 |
| **Phase 4** | 受工作区根目录严格限定的本地文件系统（`fs_*`）与受控超时 Shell（`shell_exec`）工具集 | ✅ 已完成 |
| **Phase 5** | 五域细粒度权限引擎（`READ` / `WRITE` / `EXECUTE` / `GIT` / `BROWSER`）、会话级授权与交互式审批 UI | ✅ 已完成 |
| **Phase 6** | 零 Shell 插值的原生 Git 状态检视、Diff 分析、暂存与提交工具集（`git_*`） | ✅ 已完成 |
| **Phase 7** | 按工作区隔离的纯本地项目记忆（`memory_*`）与可复用编码 Skills 系统（`skill_*`，零云端依赖） | ✅ 已完成 |
| **Phase 8** | Rust Native Host 原生 MCP `2024-11-05` stdio 协议桥接、Options 白名单管控与 `BROWSER` 域工具 | ✅ 已完成 |

---

## 安全设计准则

1. **零默认信任（Zero Implicit Trust）**：网页端任何 DOM 内容均被严格视为不可信输入，绝不在页面上下文执行代码或动态求值（无 `eval` / `new Function`），所有 21 项工具均开启 `additionalProperties: false` 拒绝任何未声明字段夹带。
2. **双层工作区沙箱（Dual-Layer Confinement）**：Extension 网关预检归一化相对路径并由后台注入可信 `workspaceRoot`；Rust 宿主再次通过 `std::fs::canonicalize` 验证目标路径及新建父目录祖先链，彻底阻断 `../` 目录穿越、前缀同名碰撞与外部符号链接逃逸。
3. **零命令夹带的 MCP 白名单（Allowlisted MCP Launch）**：模型调用 `mcp_list_tools` / `mcp_call_tool` 时仅允许传递 `serverId`，实际可执行文件与参数完全由用户在 Options 设置页显式配置，杜绝提示词注入触发任意程序执行。
4. **最小表面积日志**：审批摘要与调试日志自动对长文本与文件内容脱敏折叠（如 `content: "<642 chars>"`），绝不向外部泄露源代码或敏感凭据。
