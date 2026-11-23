#!/usr/bin/env node
/**
 * codex-bridge.mjs — Persistent ACP bridge daemon & CLI for @agentclientprotocol/codex-acp
 *
 * Designed for Antigravity acting as a secretary orchestrating long-running Codex sessions:
 *   - Persistent codex-acp subprocess over stdio JSON-RPC 2.0
 *   - Local Windows named pipe IPC (zero open TCP ports, zero external dependencies)
 *   - Full-access default mode (INITIAL_AGENT_MODE=agent-full-access)
 *   - Non-blocking task dispatch (`send`), reactive sentinel watching (`watch`),
 *     mid-turn steering (`steer` via `_session/steering`), graceful cancellation
 *     (`cancel` via `session/cancel`), mode switching, project name lookup, and
 *     `codex.cmd queue` fallback for threads locked by Codex Desktop App.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { EventEmitter } from "node:events";

const PIPE_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\antigravity-codex-acp-bridge-v1"
    : path.join(os.tmpdir(), "antigravity-codex-acp-bridge-v1.sock");

const HOME_DIR = os.homedir();
const STATE_DIR = process.env.CODEX_BRIDGE_STATE_DIR || path.join(HOME_DIR, ".gemini", "codex-bridge");
const LOGS_DIR = path.join(STATE_DIR, "logs");
const DAEMON_META_PATH = path.join(STATE_DIR, "daemon.json");
const DAEMON_STDERR_LOG = path.join(STATE_DIR, "daemon.log");
const BUTLER_CONFIG_PATH = path.join(STATE_DIR, "butler.json");
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME_DIR, ".codex");
const CODEX_GLOBAL_STATE = path.join(CODEX_HOME, ".codex-global-state.json");
const CODEX_STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
const CODEX_HISTORY_DB = path.join(CODEX_HOME, "thread_history_1.sqlite");

const DEFAULT_MODE = process.env.CODEX_BRIDGE_DEFAULT_MODE || "agent-full-access";
const DEFAULT_APPROVAL = process.env.CODEX_BRIDGE_APPROVAL || "auto"; // auto | manual
const DEFAULT_BUTLER_MODEL = process.env.CODEX_BRIDGE_BUTLER_MODEL || null;
const DEFAULT_BUTLER_THINKING = process.env.CODEX_BRIDGE_BUTLER_THINKING || "low";
const DEFAULT_BUTLER_TTL_MIN = Number(process.env.CODEX_BRIDGE_BUTLER_TTL_MIN || 30);
const DEFAULT_TASK_MODEL = process.env.CODEX_BRIDGE_DEFAULT_MODEL || null;
const DEFAULT_TASK_THINKING = process.env.CODEX_BRIDGE_DEFAULT_THINKING || null;

function resolveCodexAcpEntry() {
  if (process.env.CODEX_ACP_ENTRY && fs.existsSync(process.env.CODEX_ACP_ENTRY)) {
    return process.env.CODEX_ACP_ENTRY;
  }
  const appData = process.env.APPDATA || path.join(HOME_DIR, "AppData", "Roaming");
  const candidates = [
    path.join(appData, "npm", "node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js"),
    path.join(HOME_DIR, ".npm-global", "lib", "node_modules", "@agentclientprotocol", "codex-acp", "dist", "index.js"),
    "/opt/homebrew/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
    "/usr/local/lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Cannot find @agentclientprotocol/codex-acp entry. Checked: ${candidates.join(", ")}. Set CODEX_ACP_ENTRY env var.`
  );
}

function resolveCodexBinary() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return { bin: process.env.CODEX_BIN, useShell: false };
  }
  const appData = process.env.APPDATA || path.join(HOME_DIR, "AppData", "Roaming");
  if (process.platform === "win32") {
    const exeCandidates = [
      path.join(appData, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      path.join(appData, "npm", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
      path.join(appData, "npm", "node_modules", "@openai", "codex", "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe"),
      path.join(appData, "npm", "node_modules", "@agentclientprotocol", "codex-acp", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
    ];
    for (const c of exeCandidates) {
      if (fs.existsSync(c)) return { bin: c, useShell: false };
    }
    const winCmd = path.join(appData, "npm", "codex.cmd");
    if (fs.existsSync(winCmd)) return { bin: winCmd, useShell: true };
  }
  return { bin: "codex", useShell: false };
}

function resolveCodexCmd() {
  return resolveCodexBinary().bin;
}

function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function readCodexProjects() {
  try {
    if (!fs.existsSync(CODEX_GLOBAL_STATE)) return [];
    const data = JSON.parse(fs.readFileSync(CODEX_GLOBAL_STATE, "utf8"));
    const localProjects = data["local-projects"] || {};
    return Object.values(localProjects).map((p) => ({
      id: p.id,
      name: p.name,
      rootPaths: Array.isArray(p.rootPaths) ? p.rootPaths : [],
    }));
  } catch {
    return [];
  }
}

function normalizeWinPath(p) {
  const resolved = path.resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrSubPath(childPath, parentPath) {
  const c = normalizeWinPath(childPath);
  const p = normalizeWinPath(parentPath);
  if (c === p) return "exact";
  const sep = process.platform === "win32" ? "\\" : "/";
  if (c.startsWith(p + sep)) return "child";
  return null;
}

function resolveProjectTarget(input, callerCwd) {
  const projects = readCodexProjects();
  const raw = input && input.trim() ? input.trim() : null;

  // Case 1: Explicit non-path input (likely a Codex project name)
  if (raw && !fs.existsSync(raw)) {
    const exactName = projects.find(
      (p) => p.name && p.name.toLowerCase() === raw.toLowerCase()
    );
    if (exactName && exactName.rootPaths[0]) {
      return {
        cwd: exactName.rootPaths[0],
        matchType: "project_name_exact",
        matchedProject: { id: exactName.id, name: exactName.name, rootPath: exactName.rootPaths[0] },
      };
    }
    const partialName = projects.find(
      (p) => p.name && p.name.toLowerCase().includes(raw.toLowerCase())
    );
    if (partialName && partialName.rootPaths[0]) {
      return {
        cwd: partialName.rootPaths[0],
        matchType: "project_name_partial",
        matchedProject: { id: partialName.id, name: partialName.name, rootPath: partialName.rootPaths[0] },
      };
    }
    return {
      cwd: path.resolve(callerCwd || process.cwd(), raw),
      matchType: "unresolved_path",
      matchedProject: null,
    };
  }

  // Case 2: Existing directory (explicit path OR caller's current workspace cwd)
  // Strictly stay on the exact workspace directory — never jump across directories.
  const dir = path.resolve(raw || callerCwd || process.cwd());

  // 2a. Exact match against registered Codex project rootPaths
  for (const proj of projects) {
    for (const root of proj.rootPaths) {
      if (isSameOrSubPath(dir, root) === "exact") {
        return {
          cwd: dir,
          matchType: "exact_path",
          matchedProject: { id: proj.id, name: proj.name, rootPath: root },
        };
      }
    }
  }

  // 2b. Inside a registered Codex project (metadata only; keep cwd strictly as dir)
  let bestParent = null;
  for (const proj of projects) {
    for (const root of proj.rootPaths) {
      if (isSameOrSubPath(dir, root) === "child") {
        if (!bestParent || root.length > bestParent.root.length) {
          bestParent = { proj, root };
        }
      }
    }
  }
  if (bestParent) {
    return {
      cwd: dir,
      matchType: "within_project",
      matchedProject: { id: bestParent.proj.id, name: bestParent.proj.name, rootPath: bestParent.root },
    };
  }

  // 2c. Direct workspace directory (strictly use dir as-is)
  return {
    cwd: dir,
    matchType: "workspace_direct",
    matchedProject: null,
  };
}

function resolveCwdInput(input, callerCwd) {
  return resolveProjectTarget(input, callerCwd).cwd;
}

// ============================================================================
// Daemon implementation
// ============================================================================

class CodexAcpBridgeDaemon extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.nextRpcId = 1;
    this.pendingRpc = new Map();
    this.initializedInfo = null;
    this.sessions = new Map(); // sessionId -> SessionRecord
    this.startedAt = new Date().toISOString();
    this.server = null;
  }

  logDaemon(msg) {
    ensureDirs();
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      fs.appendFileSync(DAEMON_STDERR_LOG, line);
    } catch {}
  }

  async startAcp() {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.initializedInfo;
    }

    const entry = resolveCodexAcpEntry();
    this.logDaemon(`Spawning codex-acp: ${entry} (INITIAL_AGENT_MODE=${DEFAULT_MODE})`);

    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        INITIAL_AGENT_MODE: DEFAULT_MODE,
      },
    });
    this.child = child;

    child.stderr.on("data", (chunk) => {
      this.logDaemon(`[codex-acp stderr] ${chunk.toString("utf8").trimEnd()}`);
    });

    child.on("exit", (code, signal) => {
      this.logDaemon(`codex-acp exited (code=${code}, signal=${signal})`);
      for (const [, entry] of this.pendingRpc) {
        entry.reject(new Error(`codex-acp exited unexpectedly (code=${code}, signal=${signal})`));
      }
      this.pendingRpc.clear();
      this.child = null;
      this.initializedInfo = null;
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleAcpLine(line));

    this.initializedInfo = await this.rpcRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "antigravity-codex-bridge", version: "1.0.0" },
    });
    this.logDaemon(
      `Initialized codex-acp: ${JSON.stringify(this.initializedInfo?.agentInfo || {})}`
    );
    return this.initializedInfo;
  }

  rpcRequest(method, params) {
    if (!this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error("codex-acp process is not running"));
    }
    const id = this.nextRpcId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject, method });
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  rpcNotify(method, params) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("codex-acp process is not running");
    }
    const payload = { jsonrpc: "2.0", method, params };
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  rpcRespond(id, result) {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  rpcRespondError(id, code, message) {
    if (!this.child || !this.child.stdin.writable) return;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
    );
  }

  getOrCreateSession(sessionId, meta = {}) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        cwd: meta.cwd || null,
        mode: meta.mode || DEFAULT_MODE,
        model: meta.model || null,
        title: meta.title || null,
        approval: meta.approval || DEFAULT_APPROVAL,
        loading: false,
        replayedCount: 0,
        seq: 0,
        events: [],
        activeTurn: null,
        lastTurn: null,
        pendingPermissions: new Map(), // reqId -> { rpcId, request, createdAt }
        logFile: path.join(LOGS_DIR, `${sessionId}.jsonl`),
      };
      this.sessions.set(sessionId, s);
    } else {
      if (meta.cwd) s.cwd = meta.cwd;
      if (meta.mode) s.mode = meta.mode;
      if (meta.model) s.model = meta.model;
      if (meta.title) s.title = meta.title;
      if (meta.approval) s.approval = meta.approval;
    }
    return s;
  }

  recordEvent(session, type, data = {}) {
    session.seq += 1;
    const ev = {
      seq: session.seq,
      ts: new Date().toISOString(),
      sessionId: session.sessionId,
      type,
      ...data,
    };
    session.events.push(ev);
    if (session.events.length > 1000) {
      session.events.splice(0, session.events.length - 1000);
    }
    try {
      fs.appendFileSync(session.logFile, JSON.stringify(ev) + "\n");
    } catch {}
    this.emit(`session:${session.sessionId}`, ev);
    return ev;
  }

  pickAllowOption(options = []) {
    return (
      options.find((o) => o.optionId === "implement_plan") ||
      options.find((o) => o.kind === "allow_always") ||
      options.find((o) => o.kind === "allow_once") ||
      options.find((o) => /allow|yes|approve|implement/i.test(`${o.kind || ""} ${o.optionId || ""} ${o.name || ""}`)) ||
      options[0]
    );
  }

  pickRejectOption(options = []) {
    return (
      options.find((o) => o.kind === "reject_once") ||
      options.find((o) => o.kind === "reject_always") ||
      options.find((o) => /reject|deny|cancel|no/i.test(`${o.kind || ""} ${o.optionId || ""} ${o.name || ""}`)) ||
      options[options.length - 1]
    );
  }

  handleAcpLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.logDaemon(`[non-json stdout] ${line.slice(0, 300)}`);
      return;
    }

    // 1. Response to our outgoing RPC request
    if (msg.id !== undefined && !msg.method) {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message || JSON.stringify(msg.error));
          err.rpcError = msg.error;
          pending.reject(err);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // 2. Server-initiated request (e.g. session/request_permission)
    if (msg.id !== undefined && msg.method) {
      if (msg.method === "session/request_permission") {
        const params = msg.params || {};
        const session = this.getOrCreateSession(params.sessionId || "unknown");
        const options = params.options || [];
        const toolCall = params.toolCall || {};

        if (session.approval === "auto") {
          const chosen = this.pickAllowOption(options);
          this.rpcRespond(msg.id, {
            outcome: chosen
              ? { outcome: "selected", optionId: chosen.optionId }
              : { outcome: "cancelled" },
          });
          this.recordEvent(session, "permission_auto_approved", {
            toolCallId: toolCall.toolCallId,
            title: toolCall.title,
            kind: toolCall.kind,
            optionId: chosen?.optionId || null,
          });
        } else {
          const reqId = `perm_${Date.now()}_${msg.id}`;
          session.pendingPermissions.set(reqId, {
            rpcId: msg.id,
            params,
            createdAt: new Date().toISOString(),
          });
          this.recordEvent(session, "permission_required", {
            requestId: reqId,
            toolCallId: toolCall.toolCallId,
            title: toolCall.title,
            kind: toolCall.kind,
            options: options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
          });
        }
        return;
      }

      this.logDaemon(`Unsupported server request: ${msg.method}`);
      this.rpcRespondError(msg.id, -32601, `Method not supported: ${msg.method}`);
      return;
    }

    // 3. Notifications (session/update)
    if (msg.method === "session/update") {
      const sessionId = msg.params?.sessionId;
      const update = msg.params?.update;
      if (!sessionId || !update) return;
      const session = this.getOrCreateSession(sessionId);

      if (session.loading) {
        session.replayedCount += 1;
        return;
      }

      const kind = update.sessionUpdate;
      const turn = session.activeTurn;

      if (kind === "agent_message_chunk") {
        const text = update.content?.text ?? "";
        if (text && turn) turn.replyChunks.push(text);
        return;
      }

      if (kind === "agent_thought_chunk") {
        const text = update.content?.text ?? "";
        if (text && turn) turn.thoughtChunks.push(text);
        return;
      }

      if (kind === "tool_call") {
        const summary = {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          status: update.status,
        };
        if (turn) turn.toolCalls.push(summary);
        this.recordEvent(session, "tool_call", summary);
        return;
      }

      if (kind === "tool_call_update") {
        const status = update.status;
        const isError = status === "failed" || status === "error";
        if (turn) {
          const existing = turn.toolCalls.find((t) => t.toolCallId === update.toolCallId);
          if (existing) {
            if (status) existing.status = status;
            if (update.title) existing.title = update.title;
          }
        }
        if (isError || status === "completed") {
          this.recordEvent(session, isError ? "tool_error" : "tool_call_done", {
            toolCallId: update.toolCallId,
            title: update.title,
            status,
            contentPreview: update.content ? JSON.stringify(update.content).slice(0, 400) : undefined,
          });
        }
        return;
      }

      if (kind === "plan") {
        this.recordEvent(session, "plan", { entries: update.entries });
        return;
      }

      if (kind === "session_info_update") {
        if (update.title) session.title = update.title;
        if (update.title) {
          this.recordEvent(session, "session_info", { title: update.title });
        }
        return;
      }

      if (kind === "current_mode_update") {
        if (update.currentModeId) session.mode = update.currentModeId;
        this.recordEvent(session, "mode_changed", { mode: session.mode });
        return;
      }

      // Record any other notable updates concisely
      if (kind && !kind.endsWith("_chunk")) {
        this.recordEvent(session, `acp_${kind}`, {
          preview: JSON.stringify(update).slice(0, 400),
        });
      }
    }
  }

  async handleCommand(req) {
    const cmd = req.cmd;

    if (cmd === "ping") {
      return {
        ok: true,
        pid: process.pid,
        startedAt: this.startedAt,
        acpRunning: Boolean(this.child && this.child.exitCode === null),
        agentInfo: this.initializedInfo?.agentInfo || null,
        sessionCount: this.sessions.size,
      };
    }

    if (cmd === "stop") {
      setTimeout(() => this.shutdown(), 50);
      return { ok: true, message: "Daemon shutting down" };
    }

    if (cmd === "projects") {
      return { ok: true, projects: readCodexProjects() };
    }

    await this.startAcp();

    if (cmd === "list") {
      const target = req.cwd ? resolveProjectTarget(req.cwd, req.callerCwd) : null;
      const requestedCwd = target ? target.cwd : undefined;
      const sessions = [];
      let cursor = undefined;
      const maxPages = req.maxPages || 5;
      for (let i = 0; i < maxPages; i++) {
        const params = {};
        if (requestedCwd) params.cwd = requestedCwd;
        if (cursor) params.cursor = cursor;
        const res = await this.rpcRequest("session/list", params);
        if (Array.isArray(res?.sessions)) sessions.push(...res.sessions);
        if (!res?.nextCursor) break;
        cursor = res.nextCursor;
      }
      return {
        ok: true,
        cwd: requestedCwd || null,
        matchedProject: target?.matchedProject || null,
        count: sessions.length,
        sessions,
      };
    }

    if (cmd === "new") {
      const target = resolveProjectTarget(req.cwd, req.callerCwd);
      const cwd = target.cwd;
      const res = await this.rpcRequest("session/new", {
        cwd,
        mcpServers: [],
      });
      const sessionId = res.sessionId;
      const desiredMode = req.mode || DEFAULT_MODE;
      let activeMode = res.modes?.currentModeId || desiredMode;
      if (desiredMode && activeMode !== desiredMode) {
        await this.rpcRequest("session/set_mode", { sessionId, modeId: desiredMode });
        activeMode = desiredMode;
      }
      const session = this.getOrCreateSession(sessionId, {
        cwd,
        mode: activeMode,
        model: res.models?.currentModelId || null,
        approval: req.approval || DEFAULT_APPROVAL,
      });
      this.recordEvent(session, "session_created", {
        cwd,
        matchType: target.matchType,
        matchedProject: target.matchedProject,
        mode: session.mode,
        model: session.model,
        approval: session.approval,
      });
      return {
        ok: true,
        sessionId,
        cwd,
        matchType: target.matchType,
        matchedProject: target.matchedProject,
        mode: session.mode,
        model: session.model,
        approval: session.approval,
        availableModes: res.modes?.availableModes?.map((m) => m.id) || [],
        logFile: session.logFile,
      };
    }

    if (cmd === "load") {
      const sessionId = req.sessionId;
      if (!sessionId) throw new Error("Missing sessionId");
      let cwd = req.cwd ? resolveCwdInput(req.cwd, req.callerCwd) : null;

      // Auto-discover cwd from session/list if not explicitly supplied
      if (!cwd) {
        let cursor = undefined;
        for (let i = 0; i < 10; i++) {
          const listRes = await this.rpcRequest("session/list", cursor ? { cursor } : {});
          const found = (listRes?.sessions || []).find((s) => s.sessionId === sessionId);
          if (found) {
            cwd = found.cwd;
            break;
          }
          if (!listRes?.nextCursor) break;
          cursor = listRes.nextCursor;
        }
      }
      if (!cwd) cwd = resolveCwdInput(null, req.callerCwd);

      const existed = this.sessions.has(sessionId);
      const session = this.getOrCreateSession(sessionId, {
        cwd,
        approval: req.approval || DEFAULT_APPROVAL,
      });
      session.loading = true;
      session.replayedCount = 0;
      try {
        const res = await this.rpcRequest("session/load", {
          sessionId,
          cwd,
          mcpServers: [],
        });
        session.mode = res?.modes?.currentModeId || session.mode;
        session.model = res?.models?.currentModelId || session.model;
        if (req.mode && session.mode !== req.mode) {
          await this.rpcRequest("session/set_mode", { sessionId, modeId: req.mode });
          session.mode = req.mode;
        }
        this.recordEvent(session, "session_loaded", {
          cwd,
          mode: session.mode,
          model: session.model,
          replayedCount: session.replayedCount,
        });
        return {
          ok: true,
          sessionId,
          cwd,
          mode: session.mode,
          model: session.model,
          approval: session.approval,
          replayedCount: session.replayedCount,
          logFile: session.logFile,
        };
      } catch (err) {
        if (!existed) this.sessions.delete(sessionId);
        if (err?.rpcError?.data?.reason === "thread_active_writer") {
          const wrapped = new Error(
            `Session ${sessionId} is locked by another Codex client (e.g. Codex Desktop App). Close it there, create a new session, or use: codex-bridge.mjs queue ${sessionId} --text "..."`
          );
          wrapped.rpcError = err.rpcError;
          throw wrapped;
        }
        throw err;
      } finally {
        session.loading = false;
      }
    }

    if (cmd === "mode") {
      const { sessionId, mode } = req;
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} is not loaded in daemon. Run 'load' or 'new' first.`);
      await this.rpcRequest("session/set_mode", { sessionId, modeId: mode });
      session.mode = mode;
      this.recordEvent(session, "mode_changed", { mode });
      return { ok: true, sessionId, mode };
    }

    if (cmd === "approval") {
      const { sessionId, approval } = req;
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} is not loaded in daemon.`);
      if (!["auto", "manual"].includes(approval)) throw new Error("approval must be 'auto' or 'manual'");
      session.approval = approval;
      return { ok: true, sessionId, approval };
    }

    if (cmd === "send" || cmd === "ask") {
      const { sessionId, text } = req;
      if (!sessionId || !text) throw new Error("Missing sessionId or text");
      let session = this.sessions.get(sessionId);
      if (!session) {
        // Convenience: auto-load if not yet loaded
        await this.handleCommand({ cmd: "load", sessionId, cwd: req.cwd, mode: req.mode });
        session = this.sessions.get(sessionId);
      }
      if (session.activeTurn && session.activeTurn.status === "running") {
        throw new Error(
          `Session ${sessionId} already has an active running turn (${session.activeTurn.turnId}). Use 'steer' to inject mid-turn instructions or 'cancel' to abort.`
        );
      }

      const turnId = `turn_${Date.now()}`;
      const turn = {
        turnId,
        prompt: text,
        status: "running",
        startedAt: new Date().toISOString(),
        endedAt: null,
        replyChunks: [],
        thoughtChunks: [],
        toolCalls: [],
        stopReason: null,
        usage: null,
        error: null,
      };
      session.activeTurn = turn;
      const startEv = this.recordEvent(session, "turn_started", {
        turnId,
        promptPreview: text.slice(0, 300),
      });

      const promptPromise = this.rpcRequest("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      })
        .then((res) => {
          turn.status = res?.stopReason === "cancelled" ? "cancelled" : "completed";
          turn.endedAt = new Date().toISOString();
          turn.stopReason = res?.stopReason || "end_turn";
          turn.usage = res?.usage || null;
          turn.reply = turn.replyChunks.join("");
          turn.thought = turn.thoughtChunks.join("");
          session.lastTurn = turn;
          if (session.activeTurn === turn) session.activeTurn = null;
          this.recordEvent(session, turn.status === "cancelled" ? "turn_cancelled" : "turn_completed", {
            turnId,
            stopReason: turn.stopReason,
            usage: turn.usage,
            toolCallCount: turn.toolCalls.length,
            reply: turn.reply,
          });
          return turn;
        })
        .catch((err) => {
          turn.status = "error";
          turn.endedAt = new Date().toISOString();
          turn.error = err.message;
          turn.reply = turn.replyChunks.join("");
          session.lastTurn = turn;
          if (session.activeTurn === turn) session.activeTurn = null;
          this.recordEvent(session, "turn_error", {
            turnId,
            error: err.message,
            rpcError: err.rpcError,
            partialReply: turn.reply,
          });
          return turn;
        });

      if (cmd === "send") {
        // Detach promise errors (handled above) and return immediately
        return {
          ok: true,
          sessionId,
          turnId,
          seq: startEv.seq,
          status: "running",
          logFile: session.logFile,
        };
      }

      // cmd === "ask": wait for completion
      const done = await promptPromise;
      return {
        ok: done.status !== "error",
        sessionId,
        turnId: done.turnId,
        status: done.status,
        stopReason: done.stopReason,
        reply: done.reply,
        thought: done.thought || undefined,
        toolCalls: done.toolCalls,
        usage: done.usage,
        error: done.error || undefined,
      };
    }

    if (cmd === "steer") {
      const { sessionId, text } = req;
      if (!sessionId || !text) throw new Error("Missing sessionId or text");
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} is not loaded in daemon.`);
      const res = await this.rpcRequest("_session/steering", {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      const ev = this.recordEvent(session, "steered", {
        text: text.slice(0, 500),
        result: res,
      });
      return { ok: true, sessionId, seq: ev.seq, result: res };
    }

    if (cmd === "cancel") {
      const { sessionId } = req;
      if (!sessionId) throw new Error("Missing sessionId");
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} is not loaded in daemon.`);
      this.rpcNotify("session/cancel", { sessionId });
      const ev = this.recordEvent(session, "cancel_requested", {});
      return { ok: true, sessionId, seq: ev.seq };
    }

    if (cmd === "approve" || cmd === "reject") {
      const { sessionId, requestId, optionId } = req;
      const session = this.sessions.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} is not loaded in daemon.`);
      const entry = requestId
        ? session.pendingPermissions.get(requestId)
        : session.pendingPermissions.values().next().value;
      if (!entry) throw new Error("No matching pending permission request");
      const actualReqId =
        requestId || [...session.pendingPermissions.entries()].find(([, v]) => v === entry)?.[0];
      const options = entry.params?.options || [];
      let chosen;
      if (optionId) {
        chosen = options.find((o) => o.optionId === optionId);
      } else if (cmd === "approve") {
        chosen = this.pickAllowOption(options);
      } else {
        chosen = this.pickRejectOption(options);
      }
      this.rpcRespond(entry.rpcId, {
        outcome: chosen
          ? { outcome: "selected", optionId: chosen.optionId }
          : { outcome: "cancelled" },
      });
      session.pendingPermissions.delete(actualReqId);
      this.recordEvent(session, cmd === "approve" ? "permission_approved" : "permission_rejected", {
        requestId: actualReqId,
        optionId: chosen?.optionId || null,
      });
      return { ok: true, sessionId, requestId: actualReqId, optionId: chosen?.optionId || null };
    }

    if (cmd === "status") {
      if (req.sessionId) {
        const s = this.sessions.get(req.sessionId);
        if (!s) return { ok: false, error: `Session ${req.sessionId} is not loaded in daemon` };
        return { ok: true, session: this.summarizeSession(s) };
      }
      return {
        ok: true,
        pid: process.pid,
        startedAt: this.startedAt,
        sessions: [...this.sessions.values()].map((s) => this.summarizeSession(s)),
      };
    }

    if (cmd === "log") {
      const s = this.sessions.get(req.sessionId);
      if (!s) throw new Error(`Session ${req.sessionId} is not loaded in daemon.`);
      const since = Number(req.since || 0);
      let events = s.events.filter((e) => e.seq > since);
      if (req.tail) events = events.slice(-Number(req.tail));
      return {
        ok: true,
        sessionId: s.sessionId,
        latestSeq: s.seq,
        running: Boolean(s.activeTurn),
        partialReply: s.activeTurn ? s.activeTurn.replyChunks.join("") : undefined,
        events,
      };
    }

    if (cmd === "watch") {
      const s = this.sessions.get(req.sessionId);
      if (!s) throw new Error(`Session ${req.sessionId} is not loaded in daemon.`);
      const since = Number(req.since || 0);
      const timeoutMs = Number(req.timeoutSec || 60) * 1000;
      const wakeTypes = new Set([
        "turn_completed",
        "turn_cancelled",
        "turn_error",
        "permission_required",
      ]);
      if (req.wakeOnError) wakeTypes.add("tool_error");

      const already = s.events.filter((e) => e.seq > since);
      const hitNow = already.find((e) => wakeTypes.has(e.type));
      if (hitNow || (!s.activeTurn && already.length > 0 && s.lastTurn)) {
        return {
          ok: true,
          reason: hitNow ? hitNow.type : "idle",
          sessionId: s.sessionId,
          latestSeq: s.seq,
          running: Boolean(s.activeTurn),
          events: already,
          partialReply: s.activeTurn ? s.activeTurn.replyChunks.join("") : undefined,
          lastReply: s.lastTurn?.reply,
        };
      }

      return new Promise((resolve) => {
        const collected = [...already];
        let done = false;

        const finish = (reason) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.off(`session:${s.sessionId}`, onEvent);
          resolve({
            ok: true,
            reason,
            sessionId: s.sessionId,
            latestSeq: s.seq,
            running: Boolean(s.activeTurn),
            toolCallsSoFar: s.activeTurn ? s.activeTurn.toolCalls : s.lastTurn?.toolCalls || [],
            partialReply: s.activeTurn ? s.activeTurn.replyChunks.join("") : undefined,
            lastReply: !s.activeTurn ? s.lastTurn?.reply : undefined,
            events: collected,
          });
        };

        const onEvent = (ev) => {
          if (ev.seq <= since) return;
          collected.push(ev);
          if (wakeTypes.has(ev.type)) {
            finish(ev.type);
          }
        };

        this.on(`session:${s.sessionId}`, onEvent);
        const timer = setTimeout(() => finish("timeout"), timeoutMs);
      });
    }

    throw new Error(`Unknown command: ${cmd}`);
  }

  summarizeSession(s) {
    return {
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      mode: s.mode,
      model: s.model,
      approval: s.approval,
      seq: s.seq,
      logFile: s.logFile,
      running: Boolean(s.activeTurn),
      activeTurn: s.activeTurn
        ? {
            turnId: s.activeTurn.turnId,
            startedAt: s.activeTurn.startedAt,
            toolCallCount: s.activeTurn.toolCalls.length,
            recentToolCalls: s.activeTurn.toolCalls.slice(-5),
            partialReplyPreview: s.activeTurn.replyChunks.join("").slice(-500),
          }
        : null,
      pendingPermissions: [...s.pendingPermissions.entries()].map(([id, v]) => ({
        requestId: id,
        title: v.params?.toolCall?.title,
        kind: v.params?.toolCall?.kind,
        options: v.params?.options?.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      })),
      lastTurn: s.lastTurn
        ? {
            turnId: s.lastTurn.turnId,
            status: s.lastTurn.status,
            stopReason: s.lastTurn.stopReason,
            endedAt: s.lastTurn.endedAt,
            replyPreview: (s.lastTurn.reply || "").slice(0, 500),
          }
        : null,
    };
  }

  async serve() {
    ensureDirs();
    if (process.platform !== "win32" && fs.existsSync(PIPE_PATH)) {
      try {
        fs.unlinkSync(PIPE_PATH);
      } catch {}
    }

    await this.startAcp();

    this.server = net.createServer((socket) => {
      socket.on("error", () => {});
      const rl = readline.createInterface({ input: socket });
      rl.on("error", () => {});
      rl.on("line", async (line) => {
        if (!line.trim()) return;
        let req;
        try {
          req = JSON.parse(line);
        } catch (e) {
          socket.write(JSON.stringify({ ok: false, error: `Invalid JSON: ${e.message}` }) + "\n");
          return;
        }
        try {
          const result = await this.handleCommand(req);
          if (!socket.destroyed) socket.write(JSON.stringify(result) + "\n");
        } catch (err) {
          if (!socket.destroyed) {
            socket.write(
              JSON.stringify({
                ok: false,
                error: err.message,
                rpcError: err.rpcError || undefined,
              }) + "\n"
            );
          }
        }
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(PIPE_PATH, resolve);
    });

    fs.writeFileSync(
      DAEMON_META_PATH,
      JSON.stringify(
        {
          pid: process.pid,
          pipe: PIPE_PATH,
          startedAt: this.startedAt,
          defaultMode: DEFAULT_MODE,
          defaultApproval: DEFAULT_APPROVAL,
          agentInfo: this.initializedInfo?.agentInfo || null,
        },
        null,
        2
      )
    );
    this.logDaemon(`Bridge daemon listening on ${PIPE_PATH} (pid=${process.pid})`);
    console.log(
      JSON.stringify({
        ok: true,
        event: "daemon_ready",
        pid: process.pid,
        pipe: PIPE_PATH,
        defaultMode: DEFAULT_MODE,
        defaultApproval: DEFAULT_APPROVAL,
        agentInfo: this.initializedInfo?.agentInfo || null,
      })
    );

    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
  }

  shutdown() {
    this.logDaemon("Shutting down bridge daemon...");
    try {
      if (this.server) this.server.close();
    } catch {}
    try {
      if (this.child) {
        this.child.stdin.end();
        this.child.kill();
      }
    } catch {}
    try {
      if (fs.existsSync(DAEMON_META_PATH)) fs.unlinkSync(DAEMON_META_PATH);
    } catch {}
    process.exit(0);
  }
}

// ============================================================================
// IPC Client helpers
// ============================================================================

function sendIpc(payload, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE_PATH);
    let settled = false;
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error(`IPC timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.end();
      if (err) reject(err);
      else resolve(val);
    };

    socket.on("error", (err) => done(err));
    socket.on("connect", () => {
      const rl = readline.createInterface({ input: socket });
      rl.on("error", (err) => done(err));
      rl.once("line", (line) => {
        rl.close();
        try {
          done(null, JSON.parse(line));
        } catch (e) {
          done(new Error(`Invalid daemon response: ${line}`));
        }
      });
      socket.write(JSON.stringify(payload) + "\n");
    });
  });
}

async function ensureDaemonRunning() {
  try {
    const pong = await sendIpc({ cmd: "ping" }, 2000);
    if (pong?.ok) return pong;
  } catch {}

  ensureDirs();
  const scriptPath = path.resolve(process.argv[1]);
  const child = spawn(process.execPath, [scriptPath, "daemon", "run"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const pong = await sendIpc({ cmd: "ping" }, 1500);
      if (pong?.ok) return pong;
    } catch {}
  }
  throw new Error(`Failed to start codex-bridge daemon within 15s. Check ${DAEMON_STDERR_LOG}`);
}

// ============================================================================
// CLI argument parsing & execution
// ============================================================================

function parseFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function readTextInput(flags) {
  if (flags["text-file"]) {
    return fs.readFileSync(flags["text-file"], "utf8");
  }
  if (flags.stdin) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  }
  if (typeof flags.text === "string") {
    return flags.text;
  }
  throw new Error("Provide message via --text <msg>, --text-file <path>, or --stdin");
}

function runCodexCli(args) {
  return new Promise((resolve, reject) => {
    const { bin, useShell } = resolveCodexBinary();
    const child = spawn(bin, args, {
      shell: useShell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code,
        bin,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function runCodexQueueFallback(sessionId, text, cwdInput) {
  const args = ["queue", "--thread", sessionId, "--message", text, "--resume"];
  if (cwdInput) {
    args.push("-C", resolveCwdInput(cwdInput));
  }
  const res = await runCodexCli(args);
  return {
    ok: res.stdout.includes("Queued message") || res.exitCode === 0,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

async function runCodexDeleteCli(sessionId) {
  const res = await runCodexCli(["delete", "--force", sessionId]);
  return {
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

// ============================================================================
// Desktop App Soft-Takeover & Self-Rotating Butler Subsystem
// ============================================================================

let _sqliteModulePromise = null;
async function getSqliteDatabaseSync() {
  if (!_sqliteModulePromise) {
    _sqliteModulePromise = import("node:sqlite");
  }
  const mod = await _sqliteModulePromise;
  return mod.DatabaseSync;
}

async function withReadOnlyDb(dbPath, fn) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Codex SQLite database not found: ${dbPath}`);
  }
  const DatabaseSync = await getSqliteDatabaseSync();
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      return fn(db);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      if (attempt < 5 && /busy|locked/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 60 * (attempt + 1)));
        continue;
      }
      throw err;
    } finally {
      if (db) {
        try {
          db.close();
        } catch {}
      }
    }
  }
  throw lastErr;
}

function readButlerConfig() {
  try {
    if (!fs.existsSync(BUTLER_CONFIG_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(BUTLER_CONFIG_PATH, "utf8"));
    if (!Array.isArray(data.history)) {
      data.history = [];
      if (data.previousThreadId) {
        data.history.push({
          threadId: data.previousThreadId,
          projectId: data.projectId || null,
          projectName: data.projectName || null,
          model: data.model || DEFAULT_BUTLER_MODEL,
          thinking: data.thinking || DEFAULT_BUTLER_THINKING,
          status: "retired",
          createdAt: data.updatedAt || new Date().toISOString(),
          retiredAt: data.updatedAt || new Date().toISOString(),
          deletedAt: null,
        });
      }
      if (data.threadId) {
        data.history.push({
          threadId: data.threadId,
          projectId: data.projectId || null,
          projectName: data.projectName || null,
          model: data.model || DEFAULT_BUTLER_MODEL,
          thinking: data.thinking || DEFAULT_BUTLER_THINKING,
          status: "active",
          createdAt: data.updatedAt || new Date().toISOString(),
          retiredAt: null,
          deletedAt: null,
        });
      }
    }
    return data;
  } catch {
    return null;
  }
}

function writeButlerConfig(cfg, { retirePrevious = true } = {}) {
  ensureDirs();
  const now = new Date().toISOString();
  const existing = readButlerConfig();
  const history = Array.isArray(cfg.history)
    ? cfg.history.map((h) => ({ ...h }))
    : Array.isArray(existing?.history)
      ? existing.history.map((h) => ({ ...h }))
      : [];

  if (retirePrevious && cfg.threadId) {
    for (const entry of history) {
      if (entry.threadId !== cfg.threadId && entry.status === "active") {
        entry.status = "retired";
        entry.retiredAt = entry.retiredAt || now;
      }
    }
  }

  if (cfg.threadId) {
    const found = history.find((h) => h.threadId === cfg.threadId);
    if (found) {
      found.status = "active";
      found.projectId = cfg.projectId || found.projectId || null;
      found.projectName = cfg.projectName || found.projectName || null;
      found.model = cfg.model || found.model || DEFAULT_BUTLER_MODEL;
      found.thinking = cfg.thinking || found.thinking || DEFAULT_BUTLER_THINKING;
      found.retiredAt = null;
      found.deletedAt = null;
    } else {
      history.push({
        threadId: cfg.threadId,
        projectId: cfg.projectId || null,
        projectName: cfg.projectName || null,
        model: cfg.model || DEFAULT_BUTLER_MODEL,
        thinking: cfg.thinking || DEFAULT_BUTLER_THINKING,
        status: "active",
        createdAt: now,
        retiredAt: null,
        deletedAt: null,
      });
    }
  }

  const next = {
    ...cfg,
    model: cfg.model || DEFAULT_BUTLER_MODEL,
    thinking: cfg.thinking || DEFAULT_BUTLER_THINKING,
    history,
    updatedAt: now,
  };
  fs.writeFileSync(BUTLER_CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function markButlerHistoryDeleted(threadId) {
  const cfg = readButlerConfig();
  if (!cfg) return;
  const now = new Date().toISOString();
  const entry = cfg.history.find((h) => h.threadId === threadId);
  if (entry) {
    entry.status = "deleted";
    entry.deletedAt = now;
    if (!entry.retiredAt) entry.retiredAt = now;
  } else {
    cfg.history.push({
      threadId,
      projectId: cfg.projectId || null,
      projectName: cfg.projectName || null,
      model: cfg.model || DEFAULT_BUTLER_MODEL,
      thinking: cfg.thinking || DEFAULT_BUTLER_THINKING,
      status: "deleted",
      createdAt: now,
      retiredAt: now,
      deletedAt: now,
    });
  }
  fs.writeFileSync(BUTLER_CONFIG_PATH, JSON.stringify({ ...cfg, updatedAt: now }, null, 2) + "\n", "utf8");
}

function requireButlerConfig() {
  const cfg = readButlerConfig();
  if (!cfg || !cfg.threadId) {
    throw new Error(
      `No Codex Desktop butler thread configured in ${BUTLER_CONFIG_PATH}. Run: codex-bridge.mjs app butler set <threadId> [--cwd <project>]`
    );
  }
  return cfg;
}

function buildDeleteMsg(threadId) {
  return `[DELETE] 请立刻调用 mcp__codex_app__delete_thread（hostId="local", source="codex", threadId=${JSON.stringify(threadId)}）删除该会话，完成后只输出一行 JSON {"ok":true,"deleted":${JSON.stringify(threadId)}}`;
}

function buildBatchDeleteMsg(threadIds) {
  return `[DELETE_BATCH] 请依次对以下每一个 threadId 调用 mcp__codex_app__delete_thread（hostId="local", source="codex", threadId=<id>）将其删除，完成后只输出一行 JSON {"ok":true,"deleted":${JSON.stringify(threadIds)}}：\n${JSON.stringify(threadIds)}`;
}

function touchButlerLastUsed(threadId) {
  const cfg = readButlerConfig();
  if (!cfg) return;
  const now = new Date().toISOString();
  if (cfg.threadId === threadId) {
    cfg.lastUsedAt = now;
  }
  const entry = (cfg.history || []).find((h) => h.threadId === threadId);
  if (entry) entry.lastUsedAt = now;
  fs.writeFileSync(BUTLER_CONFIG_PATH, JSON.stringify({ ...cfg, updatedAt: now }, null, 2) + "\n", "utf8");
}

async function inspectButlerCacheState(cfg) {
  const ttlMin = DEFAULT_BUTLER_TTL_MIN;
  const ttlMs = ttlMin * 60 * 1000;
  let lastUsedMs = null;

  try {
    const snap = await getAppThreadSnapshot(cfg.threadId, { tail: 1 });
    const lt = snap.latestTurn;
    const turnSec = lt?.completed_at || lt?.started_at || null;
    if (turnSec) lastUsedMs = Number(turnSec) * 1000;
  } catch {}

  if (!lastUsedMs) {
    const fallbackIso = cfg.lastUsedAt || cfg.updatedAt || null;
    if (fallbackIso) {
      const parsed = Date.parse(fallbackIso);
      if (!Number.isNaN(parsed)) lastUsedMs = parsed;
    }
  }

  const ageMs = lastUsedMs ? Math.max(0, Date.now() - lastUsedMs) : Infinity;
  const expired = ageMs >= ttlMs;
  return {
    ttlMinutes: ttlMin,
    lastUsedAt: lastUsedMs ? new Date(lastUsedMs).toISOString() : null,
    ageMinutes: Number.isFinite(ageMs) ? Math.round((ageMs / 60000) * 10) / 10 : null,
    cacheHot: !expired,
    expired,
  };
}

function getRetiredButlerIds(cfg, excludeThreadId = null) {
  return (cfg?.history || [])
    .filter((h) => h.status === "retired" && h.threadId && h.threadId !== excludeThreadId)
    .map((h) => h.threadId);
}

async function tryCliDeleteRetiredButlers(ids) {
  const cliDeleted = [];
  const stillLocked = [];
  for (const id of ids) {
    const res = await runCodexDeleteCli(id);
    if (res.ok) {
      markButlerHistoryDeleted(id);
      cliDeleted.push(id);
    } else {
      stillLocked.push(id);
    }
  }
  return { cliDeleted, stillLocked };
}

function buildButlerInitPrompt() {
  return [
    "你是「Codex 桌面端线程调度管家」：绝不读代码、绝不跑终端，只按用户每条消息里的具体指令调用 mcp__codex_app__create_thread 或 mcp__codex_app__delete_thread，并严格输出要求的一行 JSON。",
    "本条消息只是初始化，现在不要调用任何工具，直接回复 READY。",
  ].join("\n");
}

function safeJsonParse(str) {
  if (typeof str !== "string") return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function summarizeAppItem(row) {
  const obj = safeJsonParse(row.item_json) || {};
  const type = row.item_type || obj.type || "unknown";
  const base = {
    ordinal: row.rollout_ordinal,
    turnId: row.turn_id,
    itemId: row.item_id,
    type,
    createdAtMs: row.created_at_ms,
    completedAtMs: row.completed_at_ms,
  };

  if (type === "userMessage") {
    const text = Array.isArray(obj.content)
      ? obj.content.map((c) => c.text || "").join("\n")
      : obj.text || "";
    return { ...base, text };
  }
  if (type === "agentMessage") {
    return { ...base, text: obj.text || "", phase: obj.phase || null };
  }
  if (type === "commandExecution") {
    return {
      ...base,
      command: obj.command || obj.cmd || null,
      status: obj.status || null,
      exitCode: obj.exitCode ?? obj.exit_code ?? null,
      outputPreview: typeof obj.aggregatedOutput === "string"
        ? obj.aggregatedOutput.slice(-400)
        : typeof obj.output === "string"
          ? obj.output.slice(-400)
          : undefined,
    };
  }
  if (type === "fileChange") {
    const changes = Array.isArray(obj.changes)
      ? obj.changes.map((c) => ({ path: c.path, kind: c.kind }))
      : undefined;
    return { ...base, status: obj.status || null, changes };
  }
  if (type === "mcpToolCall") {
    return {
      ...base,
      server: obj.server || null,
      tool: obj.tool || null,
      status: obj.status || null,
      arguments: obj.arguments || null,
      result: obj.result || null,
      error: obj.error || null,
      durationMs: obj.durationMs ?? null,
    };
  }
  if (type === "reasoning") {
    const summary = Array.isArray(obj.summary) ? obj.summary.join("\n") : "";
    return { ...base, summaryPreview: summary.slice(0, 300) };
  }
  return { ...base, rawPreview: String(row.item_json || "").slice(0, 300) };
}

function isAppItemError(summary) {
  if (!summary) return false;
  if (summary.status === "failed" || summary.status === "error") return true;
  if (summary.type === "commandExecution" && typeof summary.exitCode === "number" && summary.exitCode !== 0) {
    return true;
  }
  if (summary.type === "mcpToolCall" && summary.error != null) {
    return true;
  }
  return false;
}

async function getAppThreadMeta(threadId) {
  return withReadOnlyDb(CODEX_STATE_DB, (db) => {
    const row = db
      .prepare(
        "SELECT id, cwd, title, model, reasoning_effort, source, thread_source, originator, archived, rollout_path, created_at, updated_at, tokens_used FROM threads WHERE id = ?"
      )
      .get(threadId);
    return row ? { ...row } : null;
  });
}

async function getAppThreadSnapshot(threadId, { sinceOrdinal = 0, tail = 0 } = {}) {
  const meta = await getAppThreadMeta(threadId);
  const hist = await withReadOnlyDb(CODEX_HISTORY_DB, (db) => {
    const turns = db
      .prepare(
        "SELECT turn_id, rollout_ordinal, status, error_json, started_at, completed_at, duration_ms FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal ASC"
      )
      .all(threadId)
      .map((r) => ({ ...r }));

    const maxOrdRow = db
      .prepare("SELECT COALESCE(MAX(rollout_ordinal), 0) AS m FROM thread_items WHERE thread_id = ?")
      .get(threadId);
    const latestOrdinal = Number(maxOrdRow?.m || 0);

    let itemRows;
    if (tail > 0) {
      itemRows = db
        .prepare(
          "SELECT thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, completed_at_ms, item_type, item_json FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT ?"
        )
        .all(threadId, tail)
        .reverse();
    } else {
      itemRows = db
        .prepare(
          "SELECT thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, completed_at_ms, item_type, item_json FROM thread_items WHERE thread_id = ? AND rollout_ordinal > ? ORDER BY rollout_ordinal ASC"
        )
        .all(threadId, sinceOrdinal);
    }

    const lastAgentRow = db
      .prepare(
        "SELECT item_json FROM thread_items WHERE thread_id = ? AND item_type = 'agentMessage' ORDER BY rollout_ordinal DESC LIMIT 1"
      )
      .get(threadId);
    const lastAgent = lastAgentRow ? safeJsonParse(lastAgentRow.item_json) : null;

    return {
      turns,
      latestOrdinal,
      items: itemRows.map(summarizeAppItem),
      lastReply: lastAgent?.text || null,
    };
  });

  const latestTurn = hist.turns.length > 0 ? hist.turns[hist.turns.length - 1] : null;
  const running = Boolean(latestTurn && latestTurn.status === "inProgress");

  return {
    meta,
    threadId,
    turnCount: hist.turns.length,
    turns: hist.turns,
    latestTurn,
    running,
    latestOrdinal: hist.latestOrdinal,
    items: hist.items,
    lastReply: hist.lastReply,
  };
}

function extractCreatedThreadsFromItems(items) {
  const created = [];
  for (const it of items) {
    if (it.type !== "mcpToolCall" || it.tool !== "create_thread" || it.status !== "completed") continue;
    const text = it.result?.content?.[0]?.text;
    const parsed = safeJsonParse(text);
    if (parsed?.threadId) {
      created.push({
        threadId: parsed.threadId,
        hostId: parsed.hostId || "local",
        title: it.arguments?.title || null,
        model: it.arguments?.model || null,
        thinking: it.arguments?.thinking || null,
        projectId: it.arguments?.target?.projectId || it.arguments?.projectId || null,
        prompt: it.arguments?.prompt || null,
      });
    }
  }
  return created;
}

function extractDeletedThreadsFromItems(items) {
  const deleted = [];
  for (const it of items) {
    if (it.type !== "mcpToolCall" || it.tool !== "delete_thread" || it.status !== "completed") continue;
    const text = it.result?.content?.[0]?.text;
    const parsed = safeJsonParse(text);
    const tid = parsed?.threadId || it.arguments?.threadId;
    if (tid) {
      deleted.push({
        threadId: tid,
        deleted: parsed?.deleted !== false,
      });
    }
  }
  return deleted;
}

function extractCompactJsonFromReply(reply) {
  if (typeof reply !== "string" || !reply.trim()) return null;
  const trimmed = reply.trim();
  const direct = safeJsonParse(trimmed);
  if (direct && typeof direct === "object") return direct;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    const parsed = safeJsonParse(match[0]);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

async function watchAppThread(
  threadId,
  {
    sinceOrdinal = 0,
    prevTurnCount = null,
    timeoutSec = 60,
    wakeOnError = false,
    pollMs = 400,
  } = {}
) {
  const deadline = Date.now() + Number(timeoutSec || 60) * 1000;
  let lastSnap = null;

  while (true) {
    lastSnap = await getAppThreadSnapshot(threadId, { sinceOrdinal });
    const targetTurn =
      prevTurnCount !== null && prevTurnCount !== undefined
        ? lastSnap.turns[prevTurnCount] || null
        : lastSnap.latestTurn;

    const toolCalls = lastSnap.items.filter(
      (i) => i.type === "commandExecution" || i.type === "fileChange" || i.type === "mcpToolCall"
    );
    const agentMsgs = lastSnap.items.filter((i) => i.type === "agentMessage");
    const newReply = agentMsgs.length > 0 ? agentMsgs[agentMsgs.length - 1].text : undefined;

    if (targetTurn && targetTurn.status !== "inProgress") {
      const isErr =
        targetTurn.status === "failed" ||
        targetTurn.status === "error" ||
        Boolean(targetTurn.error_json);
      const isCancelled = targetTurn.status === "interrupted" || targetTurn.status === "cancelled";
      const reason = isErr ? "turn_error" : isCancelled ? "turn_cancelled" : "turn_completed";
      return {
        ok: !isErr,
        reason,
        sessionId: threadId,
        turnCount: lastSnap.turnCount,
        latestOrdinal: lastSnap.latestOrdinal,
        running: false,
        turn: targetTurn,
        toolCallsSoFar: toolCalls,
        lastReply: newReply !== undefined ? newReply : lastSnap.lastReply,
        items: lastSnap.items,
      };
    }

    if (wakeOnError) {
      const errItem = lastSnap.items.find(isAppItemError);
      if (errItem) {
        return {
          ok: true,
          reason: "tool_error",
          sessionId: threadId,
          turnCount: lastSnap.turnCount,
          latestOrdinal: lastSnap.latestOrdinal,
          running: lastSnap.running,
          turn: targetTurn,
          errorItem: errItem,
          toolCallsSoFar: toolCalls,
          partialReply: newReply,
          items: lastSnap.items,
        };
      }
    }

    if (Date.now() >= deadline) {
      return {
        ok: true,
        reason: "timeout",
        sessionId: threadId,
        turnCount: lastSnap.turnCount,
        latestOrdinal: lastSnap.latestOrdinal,
        running: lastSnap.running,
        turn: targetTurn,
        toolCallsSoFar: toolCalls,
        partialReply: newReply,
        lastReply: !lastSnap.running ? lastSnap.lastReply : undefined,
        items: lastSnap.items,
      };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function dispatchButlerTurn(butler, message, timeoutSec = 45) {
  const before = await getAppThreadSnapshot(butler.threadId, { sinceOrdinal: 0 });
  const qRes = await runCodexQueueFallback(butler.threadId, message, butler.cwd);
  if (!qRes.ok) {
    throw new Error(`Failed to queue message to butler ${butler.threadId}: ${qRes.stderr || qRes.stdout}`);
  }
  const watchRes = await watchAppThread(butler.threadId, {
    sinceOrdinal: before.latestOrdinal,
    prevTurnCount: before.turnCount,
    timeoutSec,
    wakeOnError: false,
    pollMs: 350,
  });
  touchButlerLastUsed(butler.threadId);
  return {
    queue: qRes,
    watch: watchRes,
    createdThreads: extractCreatedThreadsFromItems(watchRes.items || []),
    deletedThreads: extractDeletedThreadsFromItems(watchRes.items || []),
    parsedJson: extractCompactJsonFromReply(watchRes.lastReply),
  };
}

async function rotateButler({ model, thinking, cwd, title = "Codex 调度管家", deleteOldNow = false, timeoutSec = 45 } = {}) {
  const oldButler = requireButlerConfig();
  const target = cwd
    ? resolveProjectTarget(cwd, oldButler.cwd)
    : {
        cwd: oldButler.cwd,
        matchedProject: {
          id: oldButler.projectId,
          name: oldButler.projectName || null,
          rootPath: oldButler.cwd,
        },
      };
  const projectId = target.matchedProject?.id || oldButler.projectId;
  if (!projectId) {
    throw new Error("Cannot determine projectId for new butler thread.");
  }

  const butlerModel = model || oldButler.model || DEFAULT_BUTLER_MODEL;
  const butlerThinking = thinking || oldButler.thinking || DEFAULT_BUTLER_THINKING;

  const rotateArgs = {
    target: {
      type: "project",
      projectId,
      environment: { type: "local" },
    },
    thinking: butlerThinking,
    title,
    prompt: buildButlerInitPrompt(),
  };
  if (butlerModel) rotateArgs.model = butlerModel;

  const requiredKeys = Object.keys(rotateArgs).join("、");
  const turnRes = await dispatchButlerTurn(
    oldButler,
    `[ROTATE] 请原样使用下面 JSON 作为全部参数调用 mcp__codex_app__create_thread（必须保留 ${requiredKeys} 所有字段），不要执行其他操作，完成后只输出一行 JSON {"ok":true,"butler_id":"<新ID>"}：\n${JSON.stringify(rotateArgs)}`,
    timeoutSec
  );

  const newButlerId =
    turnRes.createdThreads[0]?.threadId ||
    turnRes.parsedJson?.butler_id ||
    turnRes.parsedJson?.thread_id ||
    null;

  if (!newButlerId) {
    throw new Error(
      `Butler rotation failed to create a new butler thread (reason=${turnRes.watch.reason}, reply=${turnRes.watch.lastReply || ""})`
    );
  }

  // Wait for the new butler thread to finish its READY initialization turn so oldButler is 100% idle
  const initWatch = await watchAppThread(newButlerId, {
    sinceOrdinal: 0,
    prevTurnCount: 0,
    timeoutSec: 35,
    pollMs: 350,
  });

  const newButler = writeButlerConfig({
    threadId: newButlerId,
    projectId,
    projectName: target.matchedProject?.name || oldButler.projectName || null,
    cwd: target.cwd || oldButler.cwd,
    model: butlerModel,
    thinking: butlerThinking,
    defaultTaskModel: oldButler.defaultTaskModel || null,
    defaultTaskThinking: oldButler.defaultTaskThinking || null,
    previousThreadId: oldButler.threadId,
  });

  let oldDeleted = false;
  if (deleteOldNow) {
    try {
      const delRes = await dispatchButlerTurn(
        newButler,
        buildDeleteMsg(oldButler.threadId),
        30
      );
      oldDeleted =
        delRes.deletedThreads.some((d) => d.threadId === oldButler.threadId && d.deleted) ||
        Boolean(delRes.parsedJson?.ok);
    } catch {
      const cliDel = await runCodexDeleteCli(oldButler.threadId);
      oldDeleted = cliDel.ok;
    }
    if (oldDeleted) markButlerHistoryDeleted(oldButler.threadId);
  }

  return {
    ok: true,
    oldButlerId: oldButler.threadId,
    newButler,
    initReason: initWatch.reason,
    initReply: initWatch.lastReply,
    oldDeleted,
  };
}

async function handleAppCommand(positional, flags, callerCwd) {
  const sub = positional[0] || "help";

  if (sub === "butler") {
    const action = positional[1] || "status";
    if (action === "status") {
      const cfg = readButlerConfig();
      if (!cfg) {
        return { ok: true, configured: false, configPath: BUTLER_CONFIG_PATH };
      }
      let snapshot = null;
      try {
        snapshot = await getAppThreadSnapshot(cfg.threadId, { tail: 5 });
      } catch (e) {
        snapshot = { error: e.message };
      }
      const cache = await inspectButlerCacheState(cfg);
      const retiredIds = getRetiredButlerIds(cfg, cfg.threadId);
      return {
        ok: true,
        configured: true,
        configPath: BUTLER_CONFIG_PATH,
        butler: cfg,
        cache,
        turnCount: snapshot?.turnCount ?? null,
        running: snapshot?.running ?? null,
        lastReply: snapshot?.lastReply ?? null,
        retiredCount: retiredIds.length,
        retiredIds,
      };
    }

    if (action === "list") {
      const cfg = readButlerConfig();
      if (!cfg) {
        return { ok: true, configured: false, configPath: BUTLER_CONFIG_PATH, history: [] };
      }
      const active = (cfg.history || []).filter((h) => h.status === "active");
      const retired = (cfg.history || []).filter((h) => h.status === "retired");
      const deleted = (cfg.history || []).filter((h) => h.status === "deleted");
      return {
        ok: true,
        configPath: BUTLER_CONFIG_PATH,
        activeThreadId: cfg.threadId,
        counts: { active: active.length, retired: retired.length, deleted: deleted.length },
        active,
        retired,
        deleted,
      };
    }

    if (action === "set") {
      const threadId = positional[2];
      if (!threadId) throw new Error("Usage: codex-bridge.mjs app butler set <threadId> [--cwd <project>]");
      const meta = await getAppThreadMeta(threadId);
      const rawCwd = flags.cwd || (meta?.cwd ? meta.cwd.replace(/^\\\\\?\\/, "") : callerCwd);
      const resolved = resolveProjectTarget(rawCwd, callerCwd);
      const projectId = flags["project-id"] || resolved.matchedProject?.id;
      if (!projectId) {
        throw new Error(
          `Could not resolve a registered Codex projectId from "${rawCwd}". Pass --cwd "<ProjectName>" or --project-id <id>.`
        );
      }
      const existingCfg = readButlerConfig();
      const saved = writeButlerConfig({
        threadId,
        projectId,
        projectName: resolved.matchedProject?.name || null,
        cwd: resolved.cwd,
        model: flags.model || meta?.model || DEFAULT_BUTLER_MODEL,
        thinking: flags.thinking || meta?.reasoning_effort || DEFAULT_BUTLER_THINKING,
        defaultTaskModel: flags["default-model"] || existingCfg?.defaultTaskModel || DEFAULT_TASK_MODEL,
        defaultTaskThinking: flags["default-thinking"] || existingCfg?.defaultTaskThinking || DEFAULT_TASK_THINKING,
      });
      return { ok: true, configPath: BUTLER_CONFIG_PATH, butler: saved };
    }

    if (action === "rotate") {
      const res = await rotateButler({
        model: flags.model,
        thinking: flags.thinking,
        cwd: flags.cwd,
        title: flags.title || "Codex 调度管家",
        deleteOldNow: Boolean(flags["delete-old"]),
        timeoutSec: flags.timeout ? Number(flags.timeout) : 45,
      });
      return res;
    }

    if (action === "prune") {
      const cfg = requireButlerConfig();
      const targetId = positional[2] || null;
      const toDelete = targetId
        ? [targetId]
        : getRetiredButlerIds(cfg, cfg.threadId);
      const filtered = toDelete.filter((id) => id && id !== cfg.threadId);
      if (filtered.length === 0) {
        return { ok: true, activeButlerId: cfg.threadId, prunedCount: 0, results: [] };
      }

      // Step 1: Try 0-token CLI delete first (succeeds whenever Desktop App does not hold a writer lock)
      const { cliDeleted, stillLocked } = await tryCliDeleteRetiredButlers(filtered);
      const results = cliDeleted.map((id) => ({ threadId: id, deleted: true, method: "cli_delete_zero_token" }));

      // Step 2: For any threads still locked by Desktop App, batch-delete in ONE butler MCP turn
      if (stillLocked.length > 0 && !flags["cli-only"]) {
        const delMsg = stillLocked.length === 1 ? buildDeleteMsg(stillLocked[0]) : buildBatchDeleteMsg(stillLocked);
        let mcpDeletedSet = new Set();
        try {
          const delRes = await dispatchButlerTurn(cfg, delMsg, 45);
          for (const d of delRes.deletedThreads) {
            if (d.deleted) mcpDeletedSet.add(d.threadId);
          }
        } catch {}
        for (const id of stillLocked) {
          const ok = mcpDeletedSet.has(id);
          if (ok) markButlerHistoryDeleted(id);
          results.push({ threadId: id, deleted: ok, method: "mcp_delete_thread" });
        }
      } else {
        for (const id of stillLocked) {
          results.push({ threadId: id, deleted: false, method: "cli_delete_locked" });
        }
      }

      return {
        ok: results.every((r) => r.deleted),
        activeButlerId: cfg.threadId,
        prunedCount: results.filter((r) => r.deleted).length,
        results,
      };
    }

    throw new Error(`Unknown app butler action: ${action} (expected status | list | set | rotate | prune)`);
  }

  if (sub === "new") {
    const prompt = await readTextInput(flags);
    const resolved = resolveProjectTarget(flags.cwd, callerCwd);
    const projectId = flags["project-id"] || resolved.matchedProject?.id;
    if (!projectId) {
      const names = readCodexProjects().map((p) => p.name).join(", ");
      throw new Error(
        `Target directory "${resolved.cwd}" is not a registered Codex Desktop project. Pass --cwd "<ProjectName>" (available: ${names}) or --project-id <id>.`
      );
    }

    let activeButler = requireButlerConfig();
    const cacheBefore = await inspectButlerCacheState(activeButler);
    // Default policy: rotate automatically when GPT prompt cache expired (>= 30 min) or --rotate is explicitly set;
    // reuse hot-cache active butler when < 30 min (or when --no-rotate is passed).
    const shouldRotate = flags["no-rotate"] ? false : Boolean(flags.rotate || cacheBefore.expired);
    let rotatedFrom = null;

    if (shouldRotate) {
      const rot = await rotateButler({
        model: flags["butler-model"],
        thinking: flags["butler-thinking"],
        deleteOldNow: false,
        timeoutSec: flags.timeout ? Number(flags.timeout) : 45,
      });
      activeButler = rot.newButler;
      rotatedFrom = rot.oldButlerId;
    }

    // Auto-cleanup retired butlers (authorized by user): try 0-token CLI delete first,
    // then piggyback any Desktop-locked retired butlers into this same [DISPATCH] turn (0 extra turns!).
    const skipAutoPrune = Boolean(flags["keep-retired"]);
    const retiredBefore = skipAutoPrune ? [] : getRetiredButlerIds(readButlerConfig(), activeButler.threadId);
    const { cliDeleted, stillLocked } = retiredBefore.length > 0
      ? await tryCliDeleteRetiredButlers(retiredBefore)
      : { cliDeleted: [], stillLocked: [] };

    const taskModel = flags.model || activeButler.defaultTaskModel || DEFAULT_TASK_MODEL;
    const taskThinking = flags.thinking || activeButler.defaultTaskThinking || DEFAULT_TASK_THINKING;
    const createArgs = {
      target: {
        type: "project",
        projectId,
        environment: { type: "local" },
      },
      prompt,
    };
    if (flags.title) createArgs.title = flags.title;
    if (taskModel) createArgs.model = taskModel;
    if (taskThinking) createArgs.thinking = taskThinking;

    const delHint =
      stillLocked.length > 0
        ? `并在同一轮依次调用 mcp__codex_app__delete_thread（hostId="local", source="codex"）删除以下已退役旧管家：${JSON.stringify(stillLocked)}`
        : "不要删除其他会话";
    const turnRes = await dispatchButlerTurn(
      activeButler,
      `[DISPATCH] 请原样使用下面 JSON 作为全部参数调用 mcp__codex_app__create_thread（必须保留 target、prompt 及所有给出的字段，绝不改写 prompt），${delHint}。完成后只输出一行 JSON {"ok":true,"thread_id":"<新ID>","deleted_ids":${JSON.stringify(stillLocked)}}：\n${JSON.stringify(createArgs)}`,
      flags.timeout ? Number(flags.timeout) : 45
    );

    const created = turnRes.createdThreads[0] || null;
    const newThreadId = created?.threadId || turnRes.parsedJson?.thread_id || null;
    if (!newThreadId) {
      throw new Error(
        `Butler failed to create formal thread (reason=${turnRes.watch.reason}, reply=${turnRes.watch.lastReply || ""})`
      );
    }

    const mcpDeletedRetired = [];
    for (const d of turnRes.deletedThreads) {
      if (d.deleted && stillLocked.includes(d.threadId)) {
        markButlerHistoryDeleted(d.threadId);
        mcpDeletedRetired.push(d.threadId);
      }
    }

    return {
      ok: true,
      mode: "desktop-soft-takeover",
      sessionId: newThreadId,
      uri: `codex://threads/${newThreadId}`,
      cwd: resolved.cwd,
      project: resolved.matchedProject || { id: projectId },
      title: created?.title || flags.title || null,
      model: created?.model || flags.model || null,
      thinking: created?.thinking || flags.thinking || null,
      butlerThreadId: activeButler.threadId,
      butlerCacheBefore: cacheBefore,
      rotatedFrom,
      retiredCleaned: {
        cliZeroToken: cliDeleted,
        piggybackMcp: mcpDeletedRetired,
      },
      butlerRegistryPath: BUTLER_CONFIG_PATH,
      butlerDurationMs: turnRes.watch.turn?.duration_ms ?? null,
    };
  }

  if (sub === "refresh") {
    let butler = requireButlerConfig();
    const cacheBefore = await inspectButlerCacheState(butler);
    const shouldRotate = flags["no-rotate"] ? false : Boolean(flags.rotate || cacheBefore.expired);
    let rotatedFrom = null;
    if (shouldRotate) {
      const rot = await rotateButler({
        model: flags["butler-model"],
        thinking: flags["butler-thinking"],
        deleteOldNow: false,
        timeoutSec: flags.timeout ? Number(flags.timeout) : 45,
      });
      butler = rot.newButler;
      rotatedFrom = rot.oldButlerId;
    }

    const retiredBefore = flags["keep-retired"] ? [] : getRetiredButlerIds(readButlerConfig(), butler.threadId);
    const { cliDeleted, stillLocked } = retiredBefore.length > 0
      ? await tryCliDeleteRetiredButlers(retiredBefore)
      : { cliDeleted: [], stillLocked: [] };

    const resolved = flags.cwd ? resolveProjectTarget(flags.cwd, callerCwd) : null;
    const projectId = flags["project-id"] || resolved?.matchedProject?.id || butler.projectId;
    const refreshModel = flags.model || butler.model || DEFAULT_BUTLER_MODEL;
    const refreshArgs = {
      target: {
        type: "project",
        projectId,
        environment: { type: "local" },
      },
      thinking: flags.thinking || butler.thinking || DEFAULT_BUTLER_THINKING,
      title: "[sync]",
      prompt: "OK",
    };
    if (refreshModel) refreshArgs.model = refreshModel;

    const extraDel =
      stillLocked.length > 0
        ? `，并顺手调用 mcp__codex_app__delete_thread 删除以下已退役旧管家：${JSON.stringify(stillLocked)}`
        : "";
    const turnRes = await dispatchButlerTurn(
      butler,
      `[REFRESH] 请原样使用下面 JSON 调用 mcp__codex_app__create_thread 创建一个临时低消耗对话以刷新侧边栏列表，拿到新 threadId 后立刻在同一轮调用 mcp__codex_app__delete_thread（hostId="local", source="codex", threadId=<新ID>）删除该临时对话${extraDel}。完成后只输出一行 JSON {"ok":true,"refreshed":true,"temp_thread_id":"<临时ID>","deleted":true}：\n${JSON.stringify(refreshArgs)}`,
      flags.timeout ? Number(flags.timeout) : 45
    );

    const tempThreadId =
      turnRes.createdThreads[0]?.threadId || turnRes.parsedJson?.temp_thread_id || null;
    let deleted =
      Boolean(tempThreadId && turnRes.deletedThreads.some((d) => d.threadId === tempThreadId && d.deleted)) ||
      Boolean(turnRes.parsedJson?.deleted);

    const mcpDeletedRetired = [];
    for (const d of turnRes.deletedThreads) {
      if (d.deleted && stillLocked.includes(d.threadId)) {
        markButlerHistoryDeleted(d.threadId);
        mcpDeletedRetired.push(d.threadId);
      }
    }

    if (tempThreadId && !deleted) {
      const delRes = await dispatchButlerTurn(
        butler,
        buildDeleteMsg(tempThreadId),
        30
      );
      deleted =
        delRes.deletedThreads.some((d) => d.threadId === tempThreadId && d.deleted) ||
        Boolean(delRes.parsedJson?.ok);
      if (!deleted) {
        const cliDel = await runCodexDeleteCli(tempThreadId);
        deleted = cliDel.ok;
      }
    }

    return {
      ok: Boolean(tempThreadId),
      refreshed: Boolean(tempThreadId),
      tempThreadId,
      deleted,
      butlerThreadId: butler.threadId,
      butlerCacheBefore: cacheBefore,
      rotatedFrom,
      retiredCleaned: {
        cliZeroToken: cliDeleted,
        piggybackMcp: mcpDeletedRetired,
      },
      durationMs: turnRes.watch.turn?.duration_ms ?? null,
    };
  }

  if (sub === "send") {
    const sessionId = positional[1];
    if (!sessionId) throw new Error("Usage: codex-bridge.mjs app send <sessionId> (--text ... | --stdin)");
    const text = await readTextInput(flags);
    const before = await getAppThreadSnapshot(sessionId, { sinceOrdinal: 0 });
    const targetCwd =
      flags.cwd ||
      (before.meta?.cwd ? before.meta.cwd.replace(/^\\\\\?\\/, "") : callerCwd);
    const qRes = await runCodexQueueFallback(sessionId, text, targetCwd);
    return {
      ok: qRes.ok,
      sessionId,
      sinceOrdinal: before.latestOrdinal,
      prevTurnCount: before.turnCount,
      queue: qRes,
    };
  }

  if (sub === "watch") {
    const sessionId = positional[1];
    if (!sessionId) throw new Error("Usage: codex-bridge.mjs app watch <sessionId> [--since <ord>] [--prev-turns <n>] [--timeout <sec>] [--wake-on-error]");
    return watchAppThread(sessionId, {
      sinceOrdinal: flags.since !== undefined ? Number(flags.since) : 0,
      prevTurnCount: flags["prev-turns"] !== undefined ? Number(flags["prev-turns"]) : null,
      timeoutSec: flags.timeout ? Number(flags.timeout) : 60,
      wakeOnError: Boolean(flags["wake-on-error"]),
    });
  }

  if (sub === "ask") {
    const sessionId = positional[1];
    if (!sessionId) throw new Error("Usage: codex-bridge.mjs app ask <sessionId> (--text ... | --stdin)");
    const text = await readTextInput(flags);
    const before = await getAppThreadSnapshot(sessionId, { sinceOrdinal: 0 });
    const targetCwd =
      flags.cwd ||
      (before.meta?.cwd ? before.meta.cwd.replace(/^\\\\\?\\/, "") : callerCwd);
    const qRes = await runCodexQueueFallback(sessionId, text, targetCwd);
    if (!qRes.ok) {
      return { ok: false, sessionId, queue: qRes };
    }
    return watchAppThread(sessionId, {
      sinceOrdinal: before.latestOrdinal,
      prevTurnCount: before.turnCount,
      timeoutSec: flags.timeout ? Number(flags.timeout) : 120,
      wakeOnError: Boolean(flags["wake-on-error"]),
    });
  }

  if (sub === "status") {
    const sessionId = positional[1];
    if (!sessionId) throw new Error("Usage: codex-bridge.mjs app status <sessionId>");
    const snap = await getAppThreadSnapshot(sessionId, { tail: flags.tail ? Number(flags.tail) : 10 });
    return {
      ok: Boolean(snap.meta || snap.turnCount > 0),
      sessionId,
      meta: snap.meta,
      turnCount: snap.turnCount,
      running: snap.running,
      latestTurn: snap.latestTurn,
      latestOrdinal: snap.latestOrdinal,
      lastReply: snap.lastReply,
      recentItems: snap.items,
    };
  }

  if (sub === "read") {
    const sessionId = positional[1];
    if (!sessionId) throw new Error("Usage: codex-bridge.mjs app read <sessionId> [--since <ord> | --tail <n>]");
    const snap = await getAppThreadSnapshot(sessionId, {
      sinceOrdinal: flags.since !== undefined ? Number(flags.since) : 0,
      tail: flags.tail ? Number(flags.tail) : 0,
    });
    return {
      ok: Boolean(snap.meta || snap.turnCount > 0),
      sessionId,
      turnCount: snap.turnCount,
      running: snap.running,
      latestOrdinal: snap.latestOrdinal,
      turns: snap.turns,
      lastReply: snap.lastReply,
      items: snap.items,
    };
  }

  if (sub === "delete") {
    const sessionId = positional[1];
    if (!sessionId) throw new Error("Usage: codex-bridge.mjs app delete <sessionId>");
    const butler = readButlerConfig();
    if (butler && butler.threadId && butler.threadId !== sessionId && !flags.cli) {
      try {
        const delRes = await dispatchButlerTurn(
          butler,
          buildDeleteMsg(sessionId),
          30
        );
        const deleted =
          delRes.deletedThreads.some((d) => d.threadId === sessionId && d.deleted) ||
          Boolean(delRes.parsedJson?.ok);
        if (deleted) {
          return { ok: true, method: "mcp_delete_thread", sessionId, deleted: true };
        }
      } catch {}
    }
    const cliDel = await runCodexDeleteCli(sessionId);
    return { ok: cliDel.ok, method: "cli_delete", sessionId, ...cliDel };
  }

  throw new Error(
    `Unknown app subcommand: ${sub} (expected butler | new | send | ask | watch | status | read | delete | refresh)`
  );
}

function printHelp() {
  console.log(`codex-bridge.mjs — Persistent ACP bridge & Desktop App Soft-Takeover CLI for Codex

Usage (ACP Full-Control Mode):
  node codex-bridge.mjs projects
  node codex-bridge.mjs resolve [dir-or-project]
  node codex-bridge.mjs daemon <status|start|stop|restart|run>
  node codex-bridge.mjs list [--cwd <dir-or-project>]
  node codex-bridge.mjs new [--cwd <dir-or-project>] [--mode agent-full-access] [--approval auto|manual]
  node codex-bridge.mjs load <sessionId> [--cwd <dir-or-project>] [--mode <mode>] [--approval auto|manual]
  node codex-bridge.mjs ask <sessionId> (--text "..." | --text-file <file> | --stdin)
  node codex-bridge.mjs send <sessionId> (--text "..." | --text-file <file> | --stdin)
  node codex-bridge.mjs watch <sessionId> [--since <seq>] [--timeout <sec>] [--wake-on-error]
  node codex-bridge.mjs steer <sessionId> (--text "..." | --text-file <file> | --stdin)
  node codex-bridge.mjs cancel <sessionId>
  node codex-bridge.mjs status [sessionId]
  node codex-bridge.mjs log <sessionId> [--since <seq>] [--tail <n>]
  node codex-bridge.mjs mode <sessionId> <read-only|workspace-write|agent|agent-full-access>
  node codex-bridge.mjs approval <sessionId> <auto|manual>
  node codex-bridge.mjs approve <sessionId> [requestId] [--option <optionId>]
  node codex-bridge.mjs reject <sessionId> [requestId] [--option <optionId>]
  node codex-bridge.mjs queue <sessionId> (--text "..." | --text-file <file> | --stdin) [--cwd <dir-or-project>]

Usage (Desktop App Soft-Takeover Mode — Instant Sidebar Visibility):
  node codex-bridge.mjs app butler [status | list | set <threadId> [--cwd <project>] | rotate [--delete-old] | prune [threadId] [--cli-only]]
  node codex-bridge.mjs app new [--cwd <dir-or-project>] [--title "..."] [--model <m>] [--thinking <low|medium|high>] [--rotate | --no-rotate] [--keep-retired] (--text "..." | --stdin)
  node codex-bridge.mjs app send <sessionId> (--text "..." | --text-file <file> | --stdin) [--cwd <dir-or-project>]
  node codex-bridge.mjs app ask <sessionId> (--text "..." | --text-file <file> | --stdin) [--cwd <dir-or-project>] [--timeout <sec>]
  node codex-bridge.mjs app watch <sessionId> [--since <ordinal>] [--prev-turns <n>] [--timeout <sec>] [--wake-on-error]
  node codex-bridge.mjs app status <sessionId> [--tail <n>]
  node codex-bridge.mjs app read <sessionId> [--since <ordinal> | --tail <n>]
  node codex-bridge.mjs app delete <sessionId> [--cli]
  node codex-bridge.mjs app refresh [--cwd <dir-or-project>] [--rotate | --no-rotate]
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    printHelp();
    return;
  }

  const command = args[0];
  const { positional, flags } = parseFlags(args.slice(1));
  const callerCwd = process.cwd();

  if (command === "projects") {
    console.log(JSON.stringify({ ok: true, projects: readCodexProjects() }, null, 2));
    return;
  }

  if (command === "resolve") {
    const resolved = resolveProjectTarget(positional[0] || flags.cwd, callerCwd);
    console.log(JSON.stringify({ ok: true, callerCwd, ...resolved }, null, 2));
    return;
  }

  if (command === "daemon") {
    const sub = positional[0] || "status";
    if (sub === "run") {
      const daemon = new CodexAcpBridgeDaemon();
      await daemon.serve();
      return;
    }
    if (sub === "start") {
      const info = await ensureDaemonRunning();
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    if (sub === "status") {
      try {
        const info = await sendIpc({ cmd: "ping" }, 2000);
        console.log(JSON.stringify(info, null, 2));
      } catch {
        console.log(JSON.stringify({ ok: false, running: false }, null, 2));
      }
      return;
    }
    if (sub === "stop") {
      try {
        const res = await sendIpc({ cmd: "stop" }, 3000);
        console.log(JSON.stringify(res, null, 2));
      } catch {
        console.log(JSON.stringify({ ok: true, message: "Daemon was not running" }, null, 2));
      }
      return;
    }
    if (sub === "restart") {
      try {
        await sendIpc({ cmd: "stop" }, 2000);
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
      const info = await ensureDaemonRunning();
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    throw new Error(`Unknown daemon subcommand: ${sub}`);
  }

  if (command === "queue") {
    const sessionId = positional[0];
    if (!sessionId) throw new Error("Missing sessionId");
    const text = await readTextInput(flags);
    const res = await runCodexQueueFallback(sessionId, text, flags.cwd || callerCwd);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  if (command === "app") {
    const res = await handleAppCommand(positional, flags, callerCwd);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exitCode = 1;
    return;
  }

  await ensureDaemonRunning();

  let payload;
  switch (command) {
    case "list":
      payload = {
        cmd: "list",
        cwd: flags.cwd,
        callerCwd,
        maxPages: flags["max-pages"] ? Number(flags["max-pages"]) : 5,
      };
      break;
    case "new":
      payload = {
        cmd: "new",
        cwd: flags.cwd,
        callerCwd,
        mode: flags.mode,
        approval: flags.approval,
      };
      break;
    case "load":
      payload = {
        cmd: "load",
        sessionId: positional[0],
        cwd: flags.cwd,
        callerCwd,
        mode: flags.mode,
        approval: flags.approval,
      };
      break;
    case "ask":
    case "send":
      payload = {
        cmd: command,
        sessionId: positional[0],
        text: await readTextInput(flags),
        cwd: flags.cwd,
        callerCwd,
        mode: flags.mode,
      };
      break;
    case "steer":
      payload = {
        cmd: "steer",
        sessionId: positional[0],
        text: await readTextInput(flags),
      };
      break;
    case "cancel":
      payload = { cmd: "cancel", sessionId: positional[0] };
      break;
    case "status":
      payload = { cmd: "status", sessionId: positional[0] };
      break;
    case "log":
      payload = {
        cmd: "log",
        sessionId: positional[0],
        since: flags.since ? Number(flags.since) : 0,
        tail: flags.tail ? Number(flags.tail) : undefined,
      };
      break;
    case "watch":
      payload = {
        cmd: "watch",
        sessionId: positional[0],
        since: flags.since ? Number(flags.since) : 0,
        timeoutSec: flags.timeout ? Number(flags.timeout) : 60,
        wakeOnError: Boolean(flags["wake-on-error"]),
      };
      break;
    case "mode":
      payload = { cmd: "mode", sessionId: positional[0], mode: positional[1] };
      break;
    case "approval":
      payload = { cmd: "approval", sessionId: positional[0], approval: positional[1] };
      break;
    case "approve":
    case "reject":
      payload = {
        cmd: command,
        sessionId: positional[0],
        requestId: positional[1],
        optionId: flags.option,
      };
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  const res = await sendIpc(payload);
  console.log(JSON.stringify(res, null, 2));
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});
