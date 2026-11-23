# codex-secretary

> Orchestrate local **OpenAI Codex** as a heavy programming deputy from **Antigravity** (or any agent / CLI) — with **Codex Desktop App Soft-Takeover** (instant sidebar visibility & live streaming) and **ACP Full-Control Mode** (mid-turn `steer`, graceful `cancel`, auto-approval).

[English](#english) | [中文说明](#中文说明)

---

<a id="english"></a>

## English

### Highlights

- **Zero External Script Dependencies**: `scripts/codex-bridge.mjs` runs purely on Node.js built-ins (including `node:sqlite` for concurrent read-only WAL monitoring).
- **Mode A — Desktop App Soft-Takeover (Default)**:
  - Creates new conversations **directly inside Codex Desktop App** via a lightweight **Butler Thread** (`mcp__codex_app__create_thread`), so new tasks appear **immediately in the sidebar** with live UI streaming — no app restart needed.
  - **30-Minute GPT Prompt-Cache TTL**: Reuses the active butler while prompt cache is hot (`< 30 min`), and automatically rotates to a fresh lightweight butler once expired (`>= 30 min`).
  - **Automatic Retired-Butler Cleanup**: Attempts zero-token `codex delete --force` first; any retired butler still locked by Desktop App is piggybacked into the next normal dispatch turn via `mcp__codex_app__delete_thread` (zero extra turns).
  - **Zero-Butler-Token Follow-Ups & Read-Only Supervision**: Turn 2+ uses native `codex queue` directly (fixing Windows `cmd.exe` multiline truncation) and monitors `thread_history_1.sqlite` in read-only WAL mode without writer-lock conflicts.
- **Mode B — ACP Full-Control (`@agentclientprotocol/codex-acp`) + Sidebar Refresh**:
  - Persistent local named pipe / Unix socket daemon wrapping `codex-acp`.
  - Full control: non-blocking `send`, reactive `watch` with `--wake-on-error`, mid-turn `steer` (`_session/steering`), graceful `cancel`, dynamic mode switching, and automatic permission approval.
  - **Standalone Sidebar Refresh (`app refresh`)**: Creates and immediately deletes a tiny low-cost `[sync]` thread to force Codex Desktop App to refresh its sidebar list so newly created ACP / CLI sessions show up without restarting the app.

---

### Prerequisites & Dependencies

| Dependency | Requirement | Install Command |
| :--- | :--- | :--- |
| **Node.js** | **v22.5+** (recommended **v24+**, for built-in `node:sqlite`) | [nodejs.org](https://nodejs.org/) |
| **OpenAI Codex CLI** | Required for `codex queue` & `codex delete` | `npm install -g @openai/codex` |
| **Codex Desktop App** | Required for Mode A (Soft-Takeover) & `app refresh` | Install OpenAI Codex Desktop App |
| **`@agentclientprotocol/codex-acp`** | Required for Mode B (ACP Full-Control) | `npm install -g @agentclientprotocol/codex-acp` |

Verify installation:

```bash
node -v        # >= v22.5.0
codex --help
```

---

### Installation

Clone directly into your Antigravity skills directory so `SKILL.md` and `scripts/codex-bridge.mjs` are discovered automatically:

**Windows (PowerShell):**

```powershell
git clone https://github.com/hzthzt/codex-secretary.git "$env:USERPROFILE\.gemini\config\skills\codex-secretary"
```

**macOS / Linux:**

```bash
git clone https://github.com/hzthzt/codex-secretary.git "$HOME/.gemini/config/skills/codex-secretary"
```

Verify the bridge script:

```powershell
# PowerShell
$BRIDGE = Join-Path $env:USERPROFILE ".gemini\config\skills\codex-secretary\scripts\codex-bridge.mjs"
node "$BRIDGE" --help
```

---

### First-Time Configuration (Desktop Soft-Takeover Butler)

To enable **Mode A (instant sidebar visibility)** and **`app refresh`**:

1. **Create a Dedicated Butler Project (Recommended)**
   - Create an empty local folder (e.g., `D:\CodexButler` or `~/CodexButler`) and add it as a project in **Codex Desktop App** (e.g., named `CodexButler`).
   - Keeping butler threads and temporary `[sync]` refresh pings in a dedicated project keeps all your formal engineering project sidebars clean.

2. **Initialize the First Butler Thread**
   - Open a new conversation inside that butler project in **Codex Desktop App**.
   - Select a **fast, low-cost model** with **`low` thinking effort** (to minimize token cost and latency).
   - Send this initialization prompt and wait for it to reply `READY`:

   ```text
   你是「Codex 桌面端线程调度管家」：绝不读代码、绝不跑终端，只按用户每条消息里的具体指令调用 mcp__codex_app__create_thread 或 mcp__codex_app__delete_thread，并严格输出要求的一行 JSON。
   本条消息只是初始化，现在不要调用任何工具，直接回复 READY。
   ```

3. **Register the Butler & Default Models**
   - Copy the thread link (`codex://threads/<butlerThreadId>`) from Codex Desktop App and register it once:

   ```powershell
   node "$BRIDGE" app butler set <butlerThreadId> `
     --cwd "<YourButlerProject>" `
     --model "<your-cheap-butler-model>" `
     --thinking low `
     --default-model "<your-default-coding-model>" `
     --default-thinking high
   ```

   > If you omit `--model` / `--thinking`, `app butler set` automatically inherits the model and reasoning effort from the butler thread you created.
   > If you omit `--default-model` / `--default-thinking`, formal tasks created by `app new` use Codex Desktop's default model (or whatever you pass per-task via `--model` / `--thinking`).

4. **Check Butler Status**

   ```powershell
   node "$BRIDGE" app butler status
   ```

---

### Configuration Reference

Local runtime configuration is stored outside the skill repository at `~/.gemini/codex-bridge/butler.json` (never committed).

#### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CODEX_BRIDGE_BUTLER_MODEL` | *(unset → inherits `butler.json`)* | Default lightweight model used when rotating butler threads or running `app refresh`. |
| `CODEX_BRIDGE_BUTLER_THINKING` | `low` | Default reasoning effort for butler threads (`low` / `medium` / `high`). |
| `CODEX_BRIDGE_BUTLER_TTL_MIN` | `30` | GPT prompt-cache active window in minutes. Reuses active butler if `< TTL`, auto-rotates if `>= TTL`. |
| `CODEX_BRIDGE_DEFAULT_MODEL` | *(unset → `butler.json` or Codex default)* | Default model for formal conversations created via `app new` (overridden by `--model`). |
| `CODEX_BRIDGE_DEFAULT_THINKING` | *(unset → `butler.json` or Codex default)* | Default reasoning effort for formal conversations created via `app new` (overridden by `--thinking`). |
| `CODEX_BRIDGE_DEFAULT_MODE` | `agent-full-access` | Default permission mode for Mode B ACP sessions (`read-only`, `workspace-write`, `agent`, `agent-full-access`). |
| `CODEX_BRIDGE_APPROVAL` | `auto` | Default ACP permission handling (`auto` or `manual`). |
| `CODEX_HOME` | `~/.codex` | Override Codex data directory (`state_5.sqlite`, `thread_history_1.sqlite`, `.codex-global-state.json`). |
| `CODEX_BRIDGE_STATE_DIR` | `~/.gemini/codex-bridge` | Override bridge daemon state, `butler.json`, and session logs directory. |
| `CODEX_BIN` | *(auto-detected)* | Explicit path to the native `codex` binary (`codex.exe` on Windows). |
| `CODEX_ACP_ENTRY` | *(auto-detected)* | Explicit path to `@agentclientprotocol/codex-acp/dist/index.js`. |

#### Example `~/.gemini/codex-bridge/butler.json`

```json
{
  "threadId": "<active-butler-thread-uuid>",
  "projectId": "<butler-project-id>",
  "projectName": "CodexButler",
  "cwd": "/path/to/CodexButler",
  "model": "<your-lightweight-butler-model>",
  "thinking": "low",
  "defaultTaskModel": "<your-default-formal-model>",
  "defaultTaskThinking": "high",
  "history": []
}
```

To migrate your butler to a different dedicated project at any time:

```powershell
node "$BRIDGE" app butler rotate --cwd "<NewButlerProject>" --delete-old
```

---

### Mode Comparison & Quick Commands

| Mode | Commands | Instant Sidebar | Live UI Stream | Mid-turn `steer` / `cancel` | Best For |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Mode A (Default): Desktop Soft-Takeover** | `app new` → `app watch` → `app send/ask` | Yes | Yes | No | Daily tasks you want visible & interactive live in Codex Desktop App |
| **Mode B: ACP Full-Control + Sidebar Sync** | `new` → `send` → `app refresh` → `watch/steer/cancel` | Yes (`app refresh`) | No (ACP holds lock) | **Yes** | Heavy unattended refactors requiring mid-turn steering or auto-approval |
| **Standalone Sidebar Refresh** | `app refresh` | Yes | — | — | Forcing Codex Desktop App to refresh its sidebar after any external CLI/ACP session |

#### Quick Examples (PowerShell)

```powershell
[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Mode A: Create a formal task directly in Codex Desktop App (auto-checks 30-min butler cache)
"Implement feature X and run tests." | node "$BRIDGE" app new --cwd "MyProject" --title "Feature X" --stdin
node "$BRIDGE" app watch <sessionId> --since 0 --prev-turns 0 --timeout 60 --wake-on-error
"Add edge-case tests." | node "$BRIDGE" app ask <sessionId> --stdin

# Standalone sidebar refresh (works anytime)
node "$BRIDGE" app refresh

# Butler inspection & manual cleanup
node "$BRIDGE" app butler status
node "$BRIDGE" app butler list
node "$BRIDGE" app butler prune

# Mode B: ACP full-control workflow
node "$BRIDGE" daemon status
node "$BRIDGE" new
"Refactor module Y." | node "$BRIDGE" send <sessionId> --stdin
node "$BRIDGE" app refresh
node "$BRIDGE" watch <sessionId> --since 0 --timeout 60 --wake-on-error
"Focus only on file B." | node "$BRIDGE" steer <sessionId> --stdin
```

---

<a id="中文说明"></a>

## 中文说明

### 简介与核心特性

`codex-secretary` 是一个面向 **Antigravity**（也支持任意 Agent 或命令行直接调用）的本地 **OpenAI Codex** 编排技能。Antigravity 扮演“秘书与监工”，Codex 扮演“重型编程副手”，所有代码读写、构建与测试严格交给 Codex 执行。

支持双模式无缝切换：

- **模式 A：Codex Desktop 软接管模式（默认）**
  - **侧边栏实时可见 + APP 内看直播**：通过常驻轻量“调度管家线程”调用 `mcp__codex_app__create_thread` 在 Desktop App 内部创建正式对话，无需重启 APP 即可在侧边栏立刻看到并实时观看流式输出。
  - **30 分钟 GPT 缓存活跃判定**：代码自动根据 `thread_history_1.sqlite` 判断距上次使用时间——30 分钟内热缓存直接复用（省 Token、响应快）；超过 30 分钟自动轮换新开轻量管家，旧管家标记为 `retired`。
  - **退役管家自动清理**：优先尝试 **0 Token** 的 `codex delete --force` 静默清理；若仍被 Desktop App 占着写锁，则在下次正常 `app new` / `app refresh` 同一轮中“搭便车”调用 `mcp__codex_app__delete_thread` 一并删掉（0 额外轮次）。
  - **零管家开销续聊 + 并发只读监工**：第二轮起跳过管家，直接通过原生 `codex.exe queue` 发送消息（彻底解决 Windows `cmd.exe` 多行换行截断问题），并通过只读 SQLite WAL（`state_5.sqlite` + `thread_history_1.sqlite`）实时追踪命令、文件修改、报错与最终回复。
- **模式 B：ACP 全控模式（`codex-acp`）+ 侧边栏同步**
  - 通过本地命名管道 / Unix Socket 守护进程常驻 `@agentclientprotocol/codex-acp`。
  - 支持非阻塞派单（`send`）、报错秒醒监工（`watch --wake-on-error`）、**中途不打断纠偏（`steer`）**、**优雅中止（`cancel`）**、动态切换权限模式与自动审批。
  - 新建 ACP 会话并发送首轮任务后，默认补跑一次独立的 `app refresh`，无需重启 Desktop App 即可把新会话刷进侧边栏。
- **独立功能：一键低消耗刷新侧边栏（`app refresh`）**
  - 用轻量模型创建一个极小的 `[sync]` 临时线程并在同一轮立即删除，强制触发 Codex Desktop App 刷新对话列表，可随时单独调用。

---

### 环境依赖

| 依赖项 | 版本 / 说明 | 安装方式 |
| :--- | :--- | :--- |
| **Node.js** | **v22.5+**（推荐 **v24+**，使用内置 `node:sqlite`，**零第三方 npm 依赖**） | [nodejs.org](https://nodejs.org/) |
| **OpenAI Codex CLI** | 提供 `codex queue` 与 `codex delete` | `npm install -g @openai/codex` |
| **Codex Desktop App** | 模式 A（软接管）与 `app refresh` 必需 | 安装官方 Codex Desktop App |
| **`@agentclientprotocol/codex-acp`** | 模式 B（ACP 全控）必需 | `npm install -g @agentclientprotocol/codex-acp` |

---

### 安装教程

直接克隆到 Antigravity 的全局 skills 目录即可生效：

**Windows（PowerShell）：**

```powershell
git clone https://github.com/hzthzt/codex-secretary.git "$env:USERPROFILE\.gemini\config\skills\codex-secretary"
```

**macOS / Linux：**

```bash
git clone https://github.com/hzthzt/codex-secretary.git "$HOME/.gemini/config/skills/codex-secretary"
```

验证脚本可用：

```powershell
$BRIDGE = Join-Path $env:USERPROFILE ".gemini\config\skills\codex-secretary\scripts\codex-bridge.mjs"
node "$BRIDGE" --help
```

---

### 首次配置（必看：管家项目、管家模型与默认对话模型）

1. **新建专属管家项目（强烈推荐）**
   - 在本机新建一个空目录（例如 `D:\CodexButler` 或 `~/CodexButler`），并在 **Codex Desktop App** 里将其添加为一个独立项目。
   - 这样所有的管家线程、轮换记录和 `[sync]` 刷新临时线程都会隔离在管家专区里，完全不会弄乱你的正式项目侧边栏。

2. **创建初始管家线程**
   - 在 Codex Desktop App 的专属管家项目下手动新建一条对话。
   - 为这条对话选一个**便宜、响应快的低级模型**，思考强度设为 **`low`**。
   - 发送下面这段初始化提示词，等待它回复 `READY`：

   ```text
   你是「Codex 桌面端线程调度管家」：绝不读代码、绝不跑终端，只按用户每条消息里的具体指令调用 mcp__codex_app__create_thread 或 mcp__codex_app__delete_thread，并严格输出要求的一行 JSON。
   本条消息只是初始化，现在不要调用任何工具，直接回复 READY。
   ```

3. **绑定管家并配置默认模型**
   - 在 Desktop App 中复制该对话的链接（`codex://threads/<butlerThreadId>`），执行一次注册命令：

   ```powershell
   node "$BRIDGE" app butler set <butlerThreadId> `
     --cwd "<你的管家项目名，如 CodexButler>" `
     --model "<默认线程管家模型>" `
     --thinking low `
     --default-model "<默认正式对话主力模型>" `
     --default-thinking high
   ```

   - **参数说明**：
     - `--cwd`：**默认管家项目**（后续所有管家轮换和 `app refresh` 都会自动落在该项目下）。
     - `--model` / `--thinking`：**默认线程管家模型与思考强度**（不传时会自动继承你刚才在 APP 里建这条管家线程所选的模型和思考强度）。
     - `--default-model` / `--default-thinking`：**默认正式对话模型与思考强度**（执行 `app new` 创建正式任务时默认使用；不传则由 Codex Desktop 按默认模型决定，单次任务也可随时通过 `--model` / `--thinking` 临时覆盖）。

4. **检查配置与缓存状态**

   ```powershell
   node "$BRIDGE" app butler status
   ```

---

### 全部可配置项一览

所有本机运行时状态保存在 skill 目录之外的 `~/.gemini/codex-bridge/butler.json`（不会被提交进 Git）。

| 配置项（环境变量） | 对应 `butler.json` 字段 | 默认值 | 作用说明 |
| :--- | :--- | :--- | :--- |
| `CODEX_BRIDGE_BUTLER_MODEL` | `model` | 继承注册管家模型 | 轮换新管家与 `app refresh` 使用的轻量模型 |
| `CODEX_BRIDGE_BUTLER_THINKING` | `thinking` | `low` | 管家线程的思考强度 |
| `CODEX_BRIDGE_BUTLER_TTL_MIN` | — | `30`（分钟） | 活跃管家缓存有效期；超过即自动轮换新管家 |
| `CODEX_BRIDGE_DEFAULT_MODEL` | `defaultTaskModel` | 不指定（用 APP 默认） | `app new` 创建正式对话时的默认主力模型 |
| `CODEX_BRIDGE_DEFAULT_THINKING` | `defaultTaskThinking` | 不指定（用 APP 默认） | `app new` 创建正式对话时的默认思考强度 |
| — | `projectName` / `projectId` / `cwd` | 绑定时指定 | 默认管家专区项目（可随时用 `app butler rotate --cwd "<新项目>" --delete-old` 迁移） |
| `CODEX_BRIDGE_DEFAULT_MODE` | — | `agent-full-access` | ACP 模式默认权限级别 |
| `CODEX_BRIDGE_APPROVAL` | — | `auto` | ACP 模式权限审批方式（`auto` / `manual`） |
| `CODEX_HOME` | — | `~/.codex` | 自定义 Codex 本地数据目录 |
| `CODEX_BRIDGE_STATE_DIR` | — | `~/.gemini/codex-bridge` | 自定义桥接状态、日志与 `butler.json` 目录 |
| `CODEX_BIN` | — | 自动探测 | 手动指定原生 `codex` 可执行文件路径 |
| `CODEX_ACP_ENTRY` | — | 自动探测 | 手动指定 `codex-acp/dist/index.js` 路径 |

---

### 常用命令速查

```powershell
[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# 1. 模式 A（默认）：在指定项目中创建正式对话（自动判断 30 分钟缓存，自动清理退役管家）
"请帮我调研模块 A 并给出修改方案。" | node "$BRIDGE" app new --cwd "MyProject" --title "模块A调研" --stdin
node "$BRIDGE" app watch <sessionId> --since 0 --prev-turns 0 --timeout 60 --wake-on-error

# 2. 跳过管家直接续聊（0 管家 Token）
"按方案实施并运行单元测试。" | node "$BRIDGE" app ask <sessionId> --stdin

# 3. 独立刷新 Codex Desktop 侧边栏
node "$BRIDGE" app refresh

# 4. 管家管理（查看状态 / 历代记录 / 手动轮换 / 清理退役管家）
node "$BRIDGE" app butler status
node "$BRIDGE" app butler list
node "$BRIDGE" app butler rotate --cwd "MyButlerProject" --delete-old
node "$BRIDGE" app butler prune

# 5. 模式 B：ACP 全控模式（支持 steer 纠偏、cancel 取消与自动审批）
node "$BRIDGE" daemon status
node "$BRIDGE" new
"重型重构任务..." | node "$BRIDGE" send <sessionId> --stdin
node "$BRIDGE" app refresh
node "$BRIDGE" watch <sessionId> --since 0 --timeout 60 --wake-on-error
"暂停修改文件 A，先修好文件 B 的单测。" | node "$BRIDGE" steer <sessionId> --stdin
node "$BRIDGE" cancel <sessionId>
```

---

### Security & Privacy Note / 隐私提醒

- Never commit `~/.gemini/codex-bridge/` (`butler.json`, `daemon.json`, `logs/`), which contains your local paths, thread IDs, and personal model preferences.
- 切勿提交 `~/.gemini/codex-bridge/` 目录，其中包含你的本地路径、历史会话 ID 与个人模型配置。
