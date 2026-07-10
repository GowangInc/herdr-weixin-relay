#!/usr/bin/env node
import http from "node:http";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chunkTextByBytes,
  ensureWeChatSessionPane,
  extractAssistantText,
  extractTextItems,
  loadAccount,
  loadContacts,
  loadResponseState,
  loadSettings,
  loadSyncBuf,
  normalizeTarget,
  pidPath,
  readOrCreateControlToken,
  removeFile,
  runCommand,
  saveSyncBuf,
  saveResponseState,
  setDefaultTarget,
  updateContact,
  writePidFile,
} from "./lib.mjs";
import { getUpdates, sendText } from "./ilink.mjs";

const MAX_TEXT_BYTES = 3500;
const DEFAULT_LONG_POLL_MS = 35_000;
const RESPONSE_WAIT_MS = 120_000;
const RESPONSE_POLL_MS = 1_000;
const pollAbortController = new AbortController();
let stopping = false;
let polling = false;
let lastPollAt = "";
let lastError = "";
const agentPaneCache = { updatedAt: 0, paneIds: new Set() };
const claimedAssistantIds = new Set();
const sessionResponseQueues = new Map();
const sessionResponseCursors = new Map();

writePidFile();
const server = await startHttpServer();
console.log(`${new Date().toISOString()} relay service started pid=${process.pid} port=${loadSettings().port}`);
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
resumePendingResponses().catch((error) => console.error(`${new Date().toISOString()} pending response resume failed: ${error.message}`));

await pollLoop();
removeFile(pidPath());
process.exit(0);

async function startHttpServer() {
  const settings = loadSettings();
  const token = readOrCreateControlToken();
  const httpServer = http.createServer(async (request, response) => {
    try {
      if (!isAuthorized(request, token)) return json(response, 401, { error: "unauthorized" });
      if (request.method === "GET" && request.url === "/health") {
        return json(response, 200, {
          ok: true,
          pid: process.pid,
          port: settings.port,
          polling,
          lastPollAt,
          lastError,
          accountConfigured: Boolean(loadAccount()?.accountId),
          targetConfigured: Boolean(loadSettings().target),
        });
      }
      if (request.method === "POST" && request.url === "/send") {
        const body = await readJsonBody(request);
        const result = await sendToWeixin(body.toUserId, body.text);
        return json(response, 200, result);
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      console.error(`${new Date().toISOString()} http error: ${error?.message || String(error)}`);
      return json(response, 500, { error: error?.message || String(error) });
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(settings.port, "127.0.0.1", resolve);
  });
  return httpServer;
}

function isAuthorized(request, token) {
  return request.headers.authorization === `Bearer ${token}`;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 1_000_000) {
        request.destroy();
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function sendToWeixin(toUserId, text) {
  const account = loadAccount();
  if (!account?.token) throw new Error("WeChat account missing; run login first.");
  const userId = String(toUserId || "").trim();
  if (!userId) throw new Error("toUserId is required");
  const message = String(text || "");
  if (!message) throw new Error("text is required");
  const contacts = loadContacts();
  const contextToken = contacts.users?.[userId]?.contextToken || "";
  const chunks = chunkTextByBytes(message, MAX_TEXT_BYTES);
  for (const chunk of chunks) {
    await sendText({ account, toUserId: userId, text: chunk, contextToken });
  }
  return { ok: true, chunks: chunks.length };
}

async function pollLoop() {
  let timeoutMs = DEFAULT_LONG_POLL_MS;
  let consecutiveFailures = 0;
  try {
    await ensureDefaultWeChatTarget();
  } catch (error) {
    console.error(`${new Date().toISOString()} failed to ensure default WeChat target: ${error.message}`);
  }
  while (!stopping) {
    const settings = loadSettings();
    const account = loadAccount();
    if (!account?.token) {
      polling = false;
      await pause(10_000);
      continue;
    }

    try {
      polling = true;
      lastPollAt = new Date().toISOString();
      const response = await getUpdates({ account, syncBuf: loadSyncBuf(), timeoutMs, abortSignal: pollAbortController.signal });
      lastError = "";
      consecutiveFailures = 0;
      if (response.get_updates_buf != null) saveSyncBuf(response.get_updates_buf);
      if (response.errcode === -14) {
        lastError = "session timeout/stale token";
        console.error(`${new Date().toISOString()} getupdates stale token; run login again if this persists`);
        await pause(60_000);
        continue;
      }
      if (response.ret && response.ret !== 0) {
        lastError = `ret=${response.ret} errcode=${response.errcode || ""} ${response.errmsg || ""}`.trim();
        console.error(`${new Date().toISOString()} getupdates returned ${lastError}`);
        await pause(5000);
        continue;
      }
      timeoutMs = clamp(Number(response.longpolling_timeout_ms || DEFAULT_LONG_POLL_MS), 5000, 60000);
      for (const message of Array.isArray(response.msgs) ? response.msgs : []) {
        handleInbound(message).catch((error) => console.error(`${new Date().toISOString()} inbound error: ${error.message}`));
      }
    } catch (error) {
      consecutiveFailures += 1;
      lastError = error?.message || String(error);
      console.error(`${new Date().toISOString()} getupdates failed (${consecutiveFailures}): ${lastError}`);
      await pause(consecutiveFailures >= 3 ? 30_000 : 2000);
      if (consecutiveFailures >= 3) consecutiveFailures = 0;
    }
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

async function handleInbound(message) {
  const fromUserId = String(message?.from_user_id || "").trim();
  if (!fromUserId || message?.message_type !== 1) return;
  const settings = loadSettings();
  if (settings.allowFrom.size && !settings.allowFrom.has(fromUserId)) {
    console.log(`${new Date().toISOString()} ignoring non-allowlisted WeChat user ${fromUserId}`);
    return;
  }

  const { text, mediaTypes } = extractTextItems(message);
  const contact = updateContact(fromUserId, {
    contextToken: message.context_token || undefined,
    lastMessageId: message.message_id || undefined,
    lastSeq: message.seq || undefined,
  });
  const inboundText = text || `[unsupported WeChat media message: ${mediaTypes.join(",") || "unknown"}]`;

  if (await handleCommand(fromUserId, inboundText, contact)) return;
  const target = contact?.target || loadSettings().target;
  if (!target?.target) {
    try {
      const sessionTarget = await ensureDefaultWeChatTarget();
      const responseWatch = await prepareResponseWatch(sessionTarget, fromUserId);
      await forwardToHerdr(sessionTarget, fromUserId, inboundText);
      if (responseWatch) queueAssistantResponseWatch(responseWatch);
      return;
    } catch (error) {
      console.error(`${new Date().toISOString()} failed to ensure WeChat session pane: ${error.message}`);
      const list = await listAvailableTargets();
      const hint = list
        ? `No Herdr target selected.\n${list}\n\nReply "/target pane:<pane-id>" or "/target agent:<agent-name>", or open a new pane and run target-current.`
        : "No Herdr target configured. Focus the target pane/agent and run the Herdr action: Route WeChat to focused pane or agent.";
      await sendToWeixin(fromUserId, hint);
      return;
    }
  }
  const responseWatch = await prepareResponseWatch(target, fromUserId);
  await forwardToHerdr(target, fromUserId, inboundText);
  if (responseWatch) queueAssistantResponseWatch(responseWatch);
}

async function handleCommand(userId, text, contact) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return false;
  const [command, ...rest] = trimmed.split(/\s+/);
  if (command === "/help") {
    await sendToWeixin(userId, "Commands: /help, /status, /target, /target agent:<name>, /target pane:<pane-id>. Normal messages are forwarded to the configured Herdr target.");
    return true;
  }
  if (command === "/status") {
    const settings = loadSettings();
    const target = contact?.target || settings.target;
    await sendToWeixin(userId, `Relay online. Account: ${loadAccount()?.accountId ? "configured" : "missing"}. Target: ${target ? `${target.kind}:${target.target}` : "unset"}. Last poll: ${lastPollAt || "never"}.`);
    return true;
  }
  if (command === "/target") {
    const rawTarget = rest.join(" ").trim();
    if (!rawTarget) {
      const target = contact?.target || loadSettings().target;
      await sendToWeixin(userId, `Target: ${target ? `${target.kind}:${target.target}` : "unset"}`);
      return true;
    }
    const target = normalizeTarget(rawTarget);
    updateContact(userId, { target });
    await sendToWeixin(userId, `Target set for this WeChat user: ${target.kind}:${target.target}`);
    return true;
  }
  return false;
}

async function forwardToHerdr(target, userId, text) {
  const settings = loadSettings();
  const isAgentPaneTarget = target.kind === "pane" && await isAgentPane(target.target);
  const decorated = `[WeChat ${userId}] ${text}`;

  if (target.kind === "agent") {
    const result = await runCommand(settings.herdrBin, ["agent", "send", target.target, decorated], { timeoutMs: 10_000 });
    if (result.status === 0) {
      console.log(`${new Date().toISOString()} forwarded WeChat message from ${userId} to agent:${target.target}`);
      return;
    }
    await handleMissingTarget(target, userId, result);
    return;
  }

  const sendResult = await runCommand(settings.herdrBin, ["pane", "send-text", target.target, decorated], { timeoutMs: 10_000 });
  if (sendResult.status !== 0) {
    await handleMissingTarget(target, userId, sendResult);
    return;
  }
  if (isAgentPaneTarget) {
    const keyResult = await runCommand(settings.herdrBin, ["pane", "send-keys", target.target, "Return"], { timeoutMs: 10_000 });
    if (keyResult.status !== 0) {
      await handleMissingTarget(target, userId, keyResult);
      return;
    }
  }
  console.log(`${new Date().toISOString()} forwarded WeChat message from ${userId} to pane:${target.target}`);
}

async function prepareResponseWatch(target, userId) {
  const sessionPath = await sessionPathForTarget(target);
  if (!sessionPath) return null;
  const watch = {
    userId,
    target,
    sessionPath,
    cursor: await sessionLineCount(sessionPath),
    startedAt: Date.now(),
  };
  rememberPendingResponse(watch);
  return watch;
}

function queueAssistantResponseWatch(watch) {
  const previous = sessionResponseQueues.get(watch.sessionPath) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => watchAndSendAssistantResponse(watch))
    .catch((error) => console.error(`${new Date().toISOString()} response bridge error: ${error.message}`))
    .finally(() => {
      if (sessionResponseQueues.get(watch.sessionPath) === next) sessionResponseQueues.delete(watch.sessionPath);
    });
  sessionResponseQueues.set(watch.sessionPath, next);
}

async function watchAndSendAssistantResponse(watch) {
  const deadline = watch.startedAt + RESPONSE_WAIT_MS;
  let keepPending = false;
  try {
    if (isWatchCursorStale(watch)) return;
    while (!stopping && Date.now() < deadline) {
      const response = await findAssistantResponse(watch);
      if (response) {
        if (!claimAssistantResponse(response.id)) return;
        try {
          await sendToWeixin(watch.userId, response.text);
          markSessionResponseCursor(watch.sessionPath, response.nextCursor);
          markAssistantResponseSent(response.id);
          console.log(`${new Date().toISOString()} sent Herdr response to WeChat user ${watch.userId}`);
        } catch (error) {
          releaseAssistantResponse(response.id);
          keepPending = true;
          throw error;
        }
        return;
      }
      await pauseResponse(RESPONSE_POLL_MS);
    }
    console.log(`${new Date().toISOString()} no Herdr response observed for WeChat user ${watch.userId}`);
  } finally {
    if (!keepPending) forgetPendingResponse(watch);
  }
}

async function findAssistantResponse(watch) {
  let raw;
  try {
    raw = await readFile(watch.sessionPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const lines = raw.split("\n").filter(Boolean);
  for (let i = watch.cursor; i < lines.length; i += 1) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = extractAssistantText(event);
    if (!text) continue;
    const id = assistantResponseId(event);
    if (!id || wasAssistantResponseSent(id)) continue;
    return { id, text, nextCursor: i + 1 };
  }
  return null;
}

function assistantResponseId(event) {
  return event?.id || event?.message?.responseId || event?.timestamp || "";
}

function isWatchCursorStale(watch) {
  return (sessionResponseCursors.get(watch.sessionPath) || 0) >= watch.cursor;
}

function markSessionResponseCursor(sessionPath, cursor) {
  const current = sessionResponseCursors.get(sessionPath) || 0;
  if (cursor > current) sessionResponseCursors.set(sessionPath, cursor);
}

function claimAssistantResponse(id) {
  if (claimedAssistantIds.has(id) || wasAssistantResponseSent(id)) return false;
  claimedAssistantIds.add(id);
  return true;
}

function releaseAssistantResponse(id) {
  claimedAssistantIds.delete(id);
}

function wasAssistantResponseSent(id) {
  return loadResponseState().sentAssistantIds.includes(id);
}

function markAssistantResponseSent(id) {
  const state = loadResponseState();
  if (!state.sentAssistantIds.includes(id)) state.sentAssistantIds.push(id);
  saveResponseState(state);
  claimedAssistantIds.delete(id);
}

function rememberPendingResponse(watch) {
  const state = loadResponseState();
  const key = responseWatchKey(watch);
  state.pendingResponses = state.pendingResponses.filter((item) => responseWatchKey(item) !== key);
  state.pendingResponses.push(serializableWatch(watch));
  saveResponseState(state);
}

function forgetPendingResponse(watch) {
  const state = loadResponseState();
  const key = responseWatchKey(watch);
  state.pendingResponses = state.pendingResponses.filter((item) => responseWatchKey(item) !== key);
  saveResponseState(state);
}

function responseWatchKey(watch) {
  return `${watch.userId}\n${watch.sessionPath}\n${watch.cursor}\n${watch.startedAt}`;
}

function serializableWatch(watch) {
  return {
    userId: watch.userId,
    target: watch.target,
    sessionPath: watch.sessionPath,
    cursor: watch.cursor,
    startedAt: watch.startedAt,
  };
}

async function resumePendingResponses() {
  const state = loadResponseState();
  for (const watch of state.pendingResponses) {
    if (!watch?.userId || !watch.sessionPath || !Number.isFinite(watch.cursor) || !Number.isFinite(watch.startedAt)) {
      forgetPendingResponse(watch || {});
      continue;
    }
    if (Date.now() >= watch.startedAt + RESPONSE_WAIT_MS) {
      forgetPendingResponse(watch);
      continue;
    }
    queueAssistantResponseWatch(watch);
  }
}

async function sessionPathForTarget(target) {
  const settings = loadSettings();
  if (target.kind === "pane") {
    const result = await runCommand(settings.herdrBin, ["pane", "get", target.target], { timeoutMs: 10_000 });
    const data = safeJsonParse(result.status === 0 ? result.stdout : null);
    return data?.result?.pane?.agent_session?.value || "";
  }
  const result = await runCommand(settings.herdrBin, ["agent", "list"], { timeoutMs: 10_000 });
  const data = safeJsonParse(result.status === 0 ? result.stdout : null);
  const agents = Array.isArray(data?.result?.agents) ? data.result.agents : [];
  const agent = agents.find((item) => item.agent === target.target);
  return agent?.agent_session?.value || "";
}

async function sessionLineCount(sessionPath) {
  try {
    const raw = await readFile(sessionPath, "utf8");
    return raw.split("\n").filter(Boolean).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function pauseResponse(ms) {
  try {
    await sleep(ms, undefined, { signal: pollAbortController.signal });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  }
}

async function handleMissingTarget(target, userId, result) {
  const raw = result.stderr || result.stdout || String(result.status);
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const code = parsed?.error?.code;
  if (code === "pane_not_found" || code === "agent_not_found") {
    console.log(`${new Date().toISOString()} target missing: ${target.kind}:${target.target}`);
    const list = await listAvailableTargets();
    const hint = list
      ? `Target ${target.kind}:${target.target} not found.\n${list}\n\nReply "/target pane:<pane-id>" or "/target agent:<agent-name>", or open a new pane and run target-current.`
      : `Target ${target.kind}:${target.target} not found. Reply "/target pane:<pane-id>" or "/target agent:<agent-name>", or run the Herdr action "Route WeChat to focused pane or agent".`;
    sendToWeixin(userId, hint).catch(() => {});
    try {
      await ensureDefaultWeChatTarget({ force: true });
    } catch (error) {
      console.error(`${new Date().toISOString()} failed to recreate WeChat session pane: ${error.message}`);
    }
    return;
  }
  throw new Error(`herdr ${target.kind === "pane" ? "pane" : "agent"} send failed: ${raw}`);
}

async function ensureDefaultWeChatTarget({ force = false } = {}) {
  const current = loadSettings().target;
  if (!force && current?.target && await targetExists(current)) return current;
  const paneId = await ensureWeChatSessionPane();
  const target = { kind: "pane", target: paneId };
  setDefaultTarget(target);
  console.log(`${new Date().toISOString()} ensured WeChat session pane: ${paneId}`);
  return target;
}

async function targetExists(target) {
  if (target.kind === "pane") return paneExists(target.target);
  return agentExists(target.target);
}

async function paneExists(paneId) {
  const settings = loadSettings();
  const result = await runCommand(settings.herdrBin, ["pane", "get", paneId], { timeoutMs: 10_000 });
  return result.status === 0;
}

async function agentExists(agentName) {
  const settings = loadSettings();
  const result = await runCommand(settings.herdrBin, ["agent", "list"], { timeoutMs: 10_000 });
  const data = safeJsonParse(result.status === 0 ? result.stdout : null);
  const agents = Array.isArray(data?.result?.agents) ? data.result.agents : [];
  return agents.some((agent) => agent.agent === agentName);
}

async function isAgentPane(paneId) {
  const now = Date.now();
  if (now - agentPaneCache.updatedAt > 30_000) {
    const settings = loadSettings();
    const result = await runCommand(settings.herdrBin, ["pane", "list"], { timeoutMs: 10_000 });
    const paneData = safeJsonParse(result.status === 0 ? result.stdout : null);
    const panes = Array.isArray(paneData?.result?.panes) ? paneData.result.panes : [];
    agentPaneCache.paneIds = new Set(panes.filter((p) => p.agent).map((p) => p.pane_id));
    agentPaneCache.updatedAt = now;
  }
  return agentPaneCache.paneIds.has(paneId);
}

async function listAvailableTargets() {
  const settings = loadSettings();
  const [paneResult, agentResult] = await Promise.allSettled([
    runCommand(settings.herdrBin, ["pane", "list"], { timeoutMs: 10_000 }),
    runCommand(settings.herdrBin, ["agent", "list"], { timeoutMs: 10_000 }),
  ]);
  const paneData = safeJsonParse(paneResult.status === "fulfilled" && paneResult.value.status === 0 ? paneResult.value.stdout : null);
  const agentData = safeJsonParse(agentResult.status === "fulfilled" && agentResult.value.status === 0 ? agentResult.value.stdout : null);
  const panes = Array.isArray(paneData?.result?.panes) ? paneData.result.panes : [];
  const agents = Array.isArray(agentData?.result?.agents) ? agentData.result.agents : [];
  if (!panes.length) return null;
  const agentPaneIds = new Set(agents.map((a) => a.pane_id).filter(Boolean));
  const lines = panes.map((pane) => {
    const id = pane.pane_id;
    const label = pane.label || pane.workspace_id || "pane";
    const agentName = pane.agent || (agentPaneIds.has(id) ? "agent" : "");
    const focused = pane.focused ? " (focused)" : "";
    const parts = [label, agentName].filter(Boolean);
    return `pane:${id}${focused} — ${parts.join(", ")}`;
  });
  return lines.join("\n");
}

function safeJsonParse(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function pause(ms) {
  try {
    await sleep(ms, undefined, { signal: pollAbortController.signal });
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  pollAbortController.abort();
  console.log(`${new Date().toISOString()} stopping relay service after ${signal}`);
  await new Promise((resolve) => server.close(resolve));
}
