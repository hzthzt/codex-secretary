---
name: codex-secretary
description: >-
  Orchestrate local OpenAI Codex as a heavy programming deputy via Codex Desktop
  soft-takeover (instant sidebar visibility) or the persistent codex-acp bridge
  while Antigravity acts as the user's secretary. Use this skill whenever the user
  asks to delegate coding, refactoring, debugging, or long-running tasks to Codex,
  communicate with or supervise a Codex session, or steer/cancel an in-progress
  Codex run.
---

# Codex Secretary (Desktop Soft-Takeover & ACP Bridge Workflow)

Use this skill to act as the user's **secretary and supervisor** while delegating heavy or long-running engineering work to local **OpenAI Codex** — either via **Codex Desktop Soft-Takeover** (default, live sidebar visibility + mid-turn `app steer`) or via **`@agentclientprotocol/codex-acp`** (full ACP control with instant `steer`, hard `cancel`, and auto-approval).

## Role Division

- **Antigravity (Secretary)**:
  - Align requirements and acceptance criteria with the user before dispatching.
  - Translate user intent into clear, scoped engineering briefs for Codex.
  - Supervise long runs: watch progress checkpoints, catch drift or tool errors early, inject mid-turn course corrections (`app steer` in Mode A or `steer` in Mode B), or gracefully hard-abort (`cancel` in Mode B; soft-stop via `app steer` in Mode A).
  - Synthesize Codex's reports, test results, and summaries into a concise executive update for the user.
- **Codex (Heavy Programming Deputy)**:
  - Owns **all** source code reading, codebase exploration, multi-file edits, builds, tests, and code-level verification.
  - **User-authorized default permission (ACP mode)**: Full access (`agent-full-access`, auto-approve). Lower the mode with `mode <sessionId> read-only` or `approval <sessionId> manual` only when the user specifically asks for read-only review or manual approval.

## Secretary File Access Guardrails (Strict)

When operating under this skill, Antigravity **MUST** follow these boundaries unless the user explicitly instructs otherwise in the current turn:

- **NEVER write, edit, create, or delete project files** (all repository modifications go strictly through Codex as the single writer).
- **DO NOT read source code files** (`.ts`, `.js`, `.py`, `.cs`, `.cpp`, `.go`, `.rs`, etc.) or scan/grep the codebase directly — delegate all code inspection, symbol lookup, and diff analysis to Codex and read Codex's report instead.
- **MAY read a small number of key documentation files** when needed to align requirements or write accurate briefs (e.g., `README.md`, design/PRD/spec docs, `AGENTS.md`, or bridge session logs under `~/.gemini/codex-bridge/logs/`).

## Bridge Controller Script

All Codex operations go through the zero-dependency bridge script located alongside this `SKILL.md`:

- Relative path: [codex-bridge.mjs](./scripts/codex-bridge.mjs)
- Resolve `$BRIDGE` dynamically to `<this-skill-directory>/scripts/codex-bridge.mjs` (for example, in PowerShell: `$BRIDGE = Join-Path $env:USERPROFILE ".gemini\config\skills\codex-secretary\scripts\codex-bridge.mjs"`, or in bash/zsh: `BRIDGE="$HOME/.gemini/config/skills/codex-secretary/scripts/codex-bridge.mjs"`).

Optional environment variables:
- `CODEX_HOME`: Custom Codex data directory (default: `~/.codex`).
- `CODEX_BRIDGE_STATE_DIR`: Custom bridge state/logs directory (default: `~/.gemini/codex-bridge`).
- `CODEX_BIN`: Explicit path to the `codex` executable (auto-detected by default).
- `CODEX_ACP_ENTRY`: Explicit path to `@agentclientprotocol/codex-acp/dist/index.js` (auto-detected by default).
- `CODEX_BRIDGE_BUTLER_MODEL`: Optional default lightweight model for butler threads (if unset, inherits the model of your registered butler thread in `butler.json`).
- `CODEX_BRIDGE_BUTLER_THINKING`: Butler reasoning effort (default: `low`).
- `CODEX_BRIDGE_BUTLER_MAX_CONTEXT_TOKENS`: Context-token threshold before auto-rotating the butler to a fresh thread (default: `75000`; set `0` to disable auto-rotation).
- `CODEX_BRIDGE_DEFAULT_MODEL`: Optional default model for newly created formal task threads (`app new`; overridden by `--model`, or stored in `butler.json` as `defaultTaskModel` via `app butler set ... --default-model <model>`).
- `CODEX_BRIDGE_DEFAULT_THINKING`: Optional default reasoning effort for newly created formal task threads (`app new`; overridden by `--thinking`, or stored in `butler.json` as `defaultTaskThinking` via `app butler set ... --default-thinking <level>`).
- `CODEX_BRIDGE_APP_POLL_MS`: Optional default poll interval in milliseconds for `app watch` / `app ask` (default: `1500`; overridden per call with `--poll-ms <ms>`).

### Execution Modes & Defaults

| Mode | Commands | Instant Sidebar Visibility | Mid-Turn Steer / Soft-Stop | Hard `cancel` / Auto-Approve | Default Rule |
| :--- | :--- | :---: | :---: | :---: | :--- |
| **Mode A: Desktop App Soft-Takeover** (Cache-aware Butler + `codex queue` + `send_message_to_thread` Steer + Read-Only SQLite Watch) | `app new` / `app steer` / `app send` / `app ask` / `app watch` / `app status` / `app read` / `app delete` / `app refresh` | **Yes (live UI)** | **Yes** (`app steer` via `mcp__codex_app__send_message_to_thread`, also supports per-turn `--model`/`--thinking`) | No (Desktop App handles UI permissions & hard Stop button) | **DEFAULT for all new tasks** inside a registered Codex Desktop project. |
| **Mode B: ACP Full-Control + Sidebar Refresh** (`codex-acp` Daemon + `app refresh`) | `new` → `send`/`ask` → `app refresh` → `watch` / `steer` / `cancel` | **Yes** (via `app refresh`) | **Yes** (direct millisecond `steer`) | **Yes** (protocol-level `cancel` & auto-approve) | Use when user explicitly requests ACP, needs hard `cancel` (aborting a stuck command mid-execution) or unattended auto-approve, or workspace is not a registered Codex Desktop project. **When using ACP `new`, default to calling `app refresh` right after dispatching the first message so the sidebar updates immediately.** |

> **Important**: `app ...` commands invoke the native `codex` binary directly (avoiding Windows `cmd.exe` newline truncation) and read SQLite WAL (`state_5.sqlite` + `thread_history_1.sqlite`) concurrently in read-only mode, so they do **not** require starting the ACP daemon. `app refresh` is a standalone command that can be run independently at any time.

---

## Mode A: Desktop App Soft-Takeover Workflow (`app ...`)

### A0. First-Time Setup (Butler Bootstrap)

1. In Codex Desktop App, add a dedicated empty folder as a project (e.g., `<YourButlerProject>`) so butler threads and `[sync]` refresh pings stay isolated from formal project sidebars.
2. Create one new thread inside that project using a fast, low-cost model with `low` thinking effort, and send:
   ```text
   你是「Codex 桌面端线程调度管家」：绝不读代码、绝不跑终端，只按用户每条消息里的具体指令调用 mcp__codex_app__create_thread、mcp__codex_app__send_message_to_thread 或 mcp__codex_app__delete_thread，并严格输出要求的一行 JSON。
   本条消息只是初始化，现在不要调用任何工具，直接回复 READY。
   ```
3. Copy its thread ID (`codex://threads/<butlerThreadId>`) and register it once:
   ```powershell
   node "$BRIDGE" app butler set <butlerThreadId> --cwd "<YourButlerProject>"
   ```
   This saves `~/.gemini/codex-bridge/butler.json` (auto-inheriting that thread's model and thinking effort).

### A1. Butler Lifecycle (75k Context-Based Rotation & Auto-Cleanup)

All butler threads ever created are tracked in `~/.gemini/codex-bridge/butler.json` (`history` array with `active` / `retired` / `deleted` status).

- **Context-based auto-rotation (default `75000` tokens, no time TTL)**:
  - **< 75k context tokens (`needsRotate: false`)**: `app new`, `app steer`, and `app refresh` **reuse** the active butler directly regardless of idle duration.
  - **≥ 75k context tokens (`needsRotate: true`)**: `app new` / `app steer` / `app refresh` **automatically rotates** to a fresh lightweight butler (inheriting the configured butler model & `low` thinking) and marks the old one `retired`.
- **Automatic cleanup of retired butlers**:
  - On `app new` / `app refresh` / `app butler prune`, `codex-bridge.mjs` first attempts **zero-token** `codex delete --force` (succeeds whenever Desktop App is not holding the thread's writer lock).
  - Any retired butler still locked by Desktop App is **piggybacked** (`mcp__codex_app__delete_thread`) into the active butler's next normal `[DISPATCH]` / `[REFRESH]` turn (zero extra turns) or batch-deleted in a single turn via `app butler prune`.

```powershell
node "$BRIDGE" app butler status
node "$BRIDGE" app butler list
node "$BRIDGE" app butler set <butlerThreadId> --cwd "<YourButlerProject>"
node "$BRIDGE" app butler rotate
node "$BRIDGE" app butler prune
```

### A2. Create a Formal Desktop Thread (Cache-Aware Butler by Default)

On Windows PowerShell, always set UTF-8 encoding before piping Chinese/multi-line prompts via `--stdin`:

```powershell
[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
"Detailed engineering brief..." | node "$BRIDGE" app new --title "Short Task Title" --stdin
```

What `app new` does automatically:
1. Resolves the current workspace (or explicit `--cwd "<ProjectOrPath>"`) to its registered Codex `projectId`.
2. Checks the active butler's **30-minute cache TTL**: reuses it if hot (`< 30 min`), or auto-rotates to a fresh lightweight butler if expired (`≥ 30 min`). Override anytime with `--rotate` (force new butler) or `--no-rotate` (force reuse).
3. Cleans up any `retired` butlers automatically (zero-token CLI delete first; any Desktop-locked retired butlers are piggybacked into this same `[DISPATCH]` turn via `mcp__codex_app__delete_thread`).
4. Optional flags: `--cwd "<ProjectOrPath>"`, `--title "..."`, `--model "<model>"`, `--thinking <low|medium|high|xhigh>`, `--rotate`, `--no-rotate`, `--keep-retired`.
5. Returns `{ sessionId, uri, butlerThreadId, butlerCacheBefore, rotatedFrom, retiredCleaned }`. The formal thread is already running Turn 1 live in Codex Desktop App.

### A3. Watch Progress & Read Results (Read-Only, Zero Lock Conflict)

Wait reactively on the newly created thread (`--prev-turns 0` for Turn 1 right after `app new`, or use `sinceOrdinal` / `prevTurnCount` returned by `app send`):

```powershell
node "$BRIDGE" app watch <sessionId> --since 0 --prev-turns 0 --timeout 60 --wake-on-error
```

Let `run_command` background the watcher if it runs longer than the synchronous wait; do **not** poll in a loop — wait for the automatic task-completion notification. On `timeout` while `running: true`, inspect `toolCallsSoFar` / `partialReply` and re-run `app watch` with `--since <latestOrdinal>`.

Inspect status or full history anytime:

```powershell
node "$BRIDGE" app status <sessionId>
node "$BRIDGE" app read <sessionId> --tail 20
```

### A4. Follow-Up Turns vs. Mid-Turn Steering (`app send` vs. `app steer`)

- **Follow-up turns when idle (Direct Queue — Zero Butler Tokens)**:
  `app send` / `app ask` invoke native `codex queue` directly (bypasses the butler completely). Note that if a turn is still running, `codex queue` strictly queues the message to run as the **next** turn after the current turn finishes.
  ```powershell
  # Quick blocking turn (queue + watch)
  "Follow-up instructions..." | node "$BRIDGE" app ask <sessionId> --stdin

  # Non-blocking dispatch (returns { sinceOrdinal, prevTurnCount }), then call app watch
  "Follow-up instructions..." | node "$BRIDGE" app send <sessionId> --stdin
  ```
- **Mid-turn real-time steering, soft-stop, or per-turn model/thinking override (`app steer`)**:
  Calls `mcp__codex_app__send_message_to_thread` via the cache-aware butler. When `<sessionId>` is currently running (`running: true`), Desktop App **injects the steering message directly into the active turn** so Codex immediately pivots or abandons remaining steps right after the current single tool call finishes (no waiting for the whole turn to finish). Also supports `--model <m>` and `--thinking <low|medium|high|xhigh>` overrides.
  ```powershell
  # Steer or soft-stop a running Desktop thread mid-turn
  "Stop refactoring file A; skip remaining steps and summarize current status." | node "$BRIDGE" app steer <sessionId> --stdin

  # Optional per-turn model/thinking override
  "Deeply audit the race condition." | node "$BRIDGE" app steer <sessionId> --model "<model>" --thinking high --stdin
  ```
  > **Hard cancel note**: Codex Desktop App has no public API to kill an in-flight shell command that is hung/blocked. For true hard cancellation (`session/cancel`), use Mode B (ACP) or click Stop in Codex Desktop App UI.

### A5. Standalone Sidebar Refresh & Thread Deletion

- **Force Codex Desktop App to refresh its sidebar list** (creates a tiny low-cost `[sync]` dummy thread via the butler and immediately deletes it — standalone command, also useful right after creating an ACP thread):
  ```powershell
  node "$BRIDGE" app refresh
  ```
- **Delete a thread cleanly from both disk and Desktop App sidebar**:
  ```powershell
  node "$BRIDGE" app delete <sessionId>
  ```

---

## Mode B: ACP Full-Control Workflow (`codex-acp` Daemon)

The daemon wraps `@agentclientprotocol/codex-acp` over a local IPC endpoint (Windows named pipe `\\.\pipe\antigravity-codex-acp-bridge-v1` or Unix socket in `os.tmpdir()`) and writes per-session NDJSON logs to `~/.gemini/codex-bridge/logs/<sessionId>.jsonl`.

### 0. Ensure the Bridge Daemon Is Running (Important on Windows)

Before creating/controlling ACP sessions in a conversation, check if the daemon is already alive:

```powershell
node "$BRIDGE" daemon status
```

If `running` is `false`, start the daemon using `run_command` with **`IsDaemon: true`** (and `WaitMsBeforeAsync: 5000`) so the daemon persists across subsequent tool calls in this conversation (normal non-daemon `run_command` calls terminate child processes when they exit on Windows):

```powershell
node "$BRIDGE" daemon run
```

Wait until its output shows `"event": "daemon_ready"` (typically 2–4 seconds), then run all subsequent client commands normally (`IsDaemon: false`).

### 1. Strict Current-Workspace Binding (Zero-Config Default)

The user opens the same project folders in Antigravity as in Codex. **Do NOT ask the user to specify a project name when you are already inside a project workspace, and NEVER jump to a different directory.**

When `--cwd` is omitted, `codex-bridge.mjs` strictly uses the caller's exact current working directory (`process.cwd()`, i.e. Antigravity's Active Workspace) as Codex's `cwd`:
- If that exact path matches a registered Codex project in `~/.codex/.codex-global-state.json`, it records `matchedProject` (`exact_path`) and naturally belongs to the same Codex project.
- It **never** remaps or jumps to another folder (even if folder names happen to match).
- **Default in a project workspace**: omit `--cwd`.
- **Explicit override**: only pass `--cwd "<ProjectOrPath>"` when the user explicitly requests operating on a *different* project.
- **Inspect or list projects**: `node "$BRIDGE" resolve` / `node "$BRIDGE" projects`

### 2. Create or Load an ACP Session

Prefer creating a dedicated session for secretary-managed work so it never collides with Codex Desktop App's active-writer lock. Inside a project workspace, omit `--cwd` to auto-match:

```powershell
node "$BRIDGE" new
```

(Or override explicitly with `--cwd "<ProjectOrPath>"` when targeting another project.)

**Default ACP Sidebar Sync**: Whenever a new ACP session is created (and its first turn is dispatched via `send`/`ask` so it has a title in `state_5.sqlite`), run the standalone sidebar refresh command so Codex Desktop App displays the new thread immediately without a restart (skip only if no butler is configured or Desktop App is closed):

```powershell
node "$BRIDGE" app refresh
```

To resume an existing unlocked session:

```powershell
node "$BRIDGE" load <sessionId>
```

> **Desktop Lock (`thread_active_writer`)**: If Codex Desktop App currently holds the thread open, `load` will fail cleanly. Either start a `new` session, switch to Mode A (`app send` / `app ask` / `app watch`), ask the user to close Codex Desktop App, or use the `queue` fallback:
> ```powershell
> node "$BRIDGE" queue <sessionId> --text "<message>" --cwd "<ProjectOrPath>"
> ```

### 3. Send Tasks (Short vs. Long-Running)

Always set UTF-8 encoding in PowerShell when piping Chinese or multi-line prompts via `--stdin` (or pass `--text-file <utf8-file>`):

```powershell
[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
```

#### A. Quick / Short Turn (`ask`)

```powershell
"Your prompt here" | node "$BRIDGE" ask <sessionId> --stdin
```

#### B. Long-Running Task with Supervision (`send` + `watch`)

1. **Dispatch non-blockingly** (returns `{ turnId, seq }`):
   ```powershell
   "Detailed engineering brief..." | node "$BRIDGE" send <sessionId> --stdin
   ```
2. **Start reactive sentinel watcher** (exits immediately on `turn_completed`, `turn_error`, `turn_cancelled`, `permission_required`, `tool_error`, or checkpoint `timeout`):
   ```powershell
   node "$BRIDGE" watch <sessionId> --since <seq> --timeout 60 --wake-on-error
   ```
   Let `run_command` background the watcher if it runs longer than the synchronous wait; do **not** poll in a loop — wait for the automatic task-completion notification.
3. **Inspect checkpoint & decide**:
   - If `reason` is `turn_completed`: review `lastReply` and summarize for the user.
   - If `reason` is `timeout` or `tool_error` and Codex is still running (`running: true`): inspect `events`, `toolCallsSoFar`, and `partialReply` (or call `status <sessionId>` / `log <sessionId> --tail 20`).
     - On track → call `watch <sessionId> --since <latestSeq> --timeout 60 --wake-on-error` again.
     - Drifting or hit a snag → inject mid-turn steering.

### 4. Mid-Turn Steering & Graceful Cancellation

- **Steer mid-turn** (`_session/steering`, injects new guidance without aborting the turn):
  ```powershell
  "Stop modifying file A; focus only on file B and run the unit tests." | node "$BRIDGE" steer <sessionId> --stdin
  ```
- **Gracefully cancel** (`session/cancel`, aborts current turn while preserving session history):
  ```powershell
  node "$BRIDGE" cancel <sessionId>
  ```

### 5. Mode, Approval & Daemon Control

- Switch mode dynamically (`read-only`, `workspace-write`, `agent`, `agent-full-access`):
  ```powershell
  node "$BRIDGE" mode <sessionId> read-only
  ```
- Toggle permission handling (`auto` default vs. `manual`):
  ```powershell
  node "$BRIDGE" approval <sessionId> manual
  node "$BRIDGE" approve <sessionId> [requestId]
  node "$BRIDGE" reject <sessionId> [requestId]
  ```
- Inspect or restart daemon:
  ```powershell
  node "$BRIDGE" daemon status
  node "$BRIDGE" daemon restart
  node "$BRIDGE" daemon stop
  ```

## Secretary Reporting Checklist

When reporting back to the user after a Codex run:
1. State the **outcome concisely** (what changed, test/verification status, any open risks).
2. Include the **`sessionId`** (`codex://threads/<sessionId>`) so the user can continue or review in Codex Desktop App (threads created via `app new` appear immediately in the sidebar; for ACP `new` threads, run `app refresh` or restart Desktop App to display them).
3. If Codex hit an ambiguous product/architecture decision, present clear options to the user before steering or continuing.
