#!/usr/bin/env node
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  chunkTextByBytes,
  extractTextItems,
  loadAccount,
  loadContacts,
  loadSettings,
  loadSyncBuf,
  normalizeTarget,
  pidPath,
  readOrCreateControlToken,
  removeFile,
  runCommand,
  saveSyncBuf,
  updateContact,
  writePidFile,
} from "./lib.mjs";
import { getUpdates, sendText } from "./ilink.mjs";

const MAX_TEXT_BYTES = 3500;
const DEFAULT_LONG_POLL_MS = 35_000;
const pollAbortController = new AbortController();
let stopping = false;
let polling = false;
let lastPollAt = "";
let lastError = "";

writePidFile();
const server = await startHttpServer();
console.log(`${new Date().toISOString()} relay service started pid=${process.pid} port=${loadSettings().port}`);
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

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
    await sendToWeixin(fromUserId, "No Herdr target configured. Focus the target pane/agent and run the Herdr action: Route WeChat to focused pane or agent.");
    return;
  }
  await forwardToHerdr(target, fromUserId, inboundText);
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
  const decorated = target.kind === "pane" ? `[WeChat ${userId}] ${text}` : `[WeChat ${userId}] ${text}\n`;
  const args = target.kind === "pane"
    ? ["pane", "send-text", target.target, decorated]
    : ["agent", "send", target.target, decorated];
  const result = await runCommand(settings.herdrBin, args, { timeoutMs: 10_000 });
  if (result.status !== 0) {
    throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${result.stderr || result.stdout || result.status}`);
  }
  console.log(`${new Date().toISOString()} forwarded WeChat message from ${userId} to ${target.kind}:${target.target}`);
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
