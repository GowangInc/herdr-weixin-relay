import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const pluginId = "local.herdr-weixin-relay";
export const pluginVersion = "0.1.0";
export const openClawWeixinVersion = "2.4.6";
export const pluginRoot = dirname(fileURLToPath(import.meta.url));

const home = homedir();
const fallbackConfigDir = join(home, ".config", "herdr", "plugins", "config", pluginId);
const fallbackStateDir = join(home, ".local", "state", "herdr", "plugins", pluginId);

export function configDir() {
  return process.env.HERDR_WEIXIN_CONFIG_DIR || process.env.HERDR_PLUGIN_CONFIG_DIR || fallbackConfigDir;
}

export function stateDir() {
  return process.env.HERDR_WEIXIN_STATE_DIR || process.env.HERDR_PLUGIN_STATE_DIR || fallbackStateDir;
}

export function ensureDirs() {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}

export function loadDotEnv(paths = [join(configDir(), ".env"), join(pluginRoot, ".env")]) {
  for (const path of paths) {
    if (existsSync(path)) loadDotEnvFile(path);
  }
}

function loadDotEnvFile(path) {
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = stripQuotes(rawValue.trim());
  }
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

export function splitList(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function envInt(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  const parsed = raw == null || raw === "" ? fallback : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (min != null && parsed < min) return min;
  if (max != null && parsed > max) return max;
  return parsed;
}

export function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writePrivateJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export function atomicWrite(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function removeFile(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function accountPath() {
  return join(stateDir(), "account.json");
}

export function loadAccount() {
  return readJsonFile(accountPath(), null);
}

export function saveAccount(account) {
  if (!account?.token || !account?.accountId) throw new Error("account token and accountId are required");
  writePrivateJson(accountPath(), {
    accountId: String(account.accountId),
    userId: account.userId ? String(account.userId) : "",
    token: String(account.token),
    baseUrl: normalizeBaseUrl(account.baseUrl || "https://ilinkai.weixin.qq.com"),
    connectedAt: account.connectedAt || new Date().toISOString(),
  });
}

export function syncBufPath() {
  return join(stateDir(), "get-updates-buf.txt");
}

export function loadSyncBuf() {
  try {
    return readFileSync(syncBufPath(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export function saveSyncBuf(value) {
  atomicWrite(syncBufPath(), String(value || ""), 0o600);
}

export function controlTokenPath() {
  return join(stateDir(), "control-token");
}

export function readOrCreateControlToken() {
  ensureDirs();
  try {
    const existing = readFileSync(controlTokenPath(), "utf8").trim();
    if (existing) return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const token = randomBytes(32).toString("hex");
  atomicWrite(controlTokenPath(), `${token}\n`, 0o600);
  return token;
}

export function contactsPath() {
  return join(stateDir(), "contacts.json");
}

export function loadContacts() {
  const contacts = readJsonFile(contactsPath(), { users: {}, lastUserId: "", defaultTarget: null });
  contacts.users ||= {};
  return contacts;
}

export function saveContacts(contacts) {
  writePrivateJson(contactsPath(), contacts);
}

export function responseStatePath() {
  return join(stateDir(), "response-state.json");
}

export function loadResponseState() {
  const state = readJsonFile(responseStatePath(), { sentAssistantIds: [], pendingResponses: [] });
  state.sentAssistantIds = Array.isArray(state.sentAssistantIds) ? state.sentAssistantIds : [];
  state.pendingResponses = Array.isArray(state.pendingResponses) ? state.pendingResponses : [];
  return state;
}

export function saveResponseState(state) {
  writePrivateJson(responseStatePath(), {
    ...state,
    sentAssistantIds: Array.isArray(state.sentAssistantIds) ? state.sentAssistantIds.slice(-200) : [],
    pendingResponses: Array.isArray(state.pendingResponses) ? state.pendingResponses.slice(-50) : [],
  });
}

export function updateContact(userId, patch) {
  if (!userId) return null;
  const contacts = loadContacts();
  const current = contacts.users[userId] || {};
  const updated = { ...current, ...patch, lastSeenAt: new Date().toISOString() };
  contacts.users[userId] = updated;
  contacts.lastUserId = userId;
  saveContacts(contacts);
  return updated;
}

export function lastContact() {
  const contacts = loadContacts();
  const userId = contacts.lastUserId || "";
  return userId ? { userId, ...(contacts.users[userId] || {}) } : null;
}

export function setDefaultTarget(target) {
  const contacts = loadContacts();
  contacts.defaultTarget = normalizeTarget(target);
  saveContacts(contacts);
  return contacts.defaultTarget;
}

export function getDefaultTarget() {
  return loadContacts().defaultTarget || null;
}

export function loadSettings() {
  ensureDirs();
  loadDotEnv();
  const envTarget = normalizeTarget(process.env.HERDR_WEIXIN_TARGET || "");
  const modelRole = validateModelRole(process.env.HERDR_WEIXIN_MODEL_ROLE || "wechat");
  return {
    port: envInt("HERDR_WEIXIN_PORT", 27187, { min: 1024, max: 65535 }),
    herdrBin: process.env.HERDR_BIN_PATH || process.env.HERDR_BIN || "herdr",
    target: envTarget || getDefaultTarget(),
    allowFrom: new Set(splitList(process.env.HERDR_WEIXIN_ALLOW_FROM)),
    botAgent: sanitizeBotAgent(process.env.HERDR_WEIXIN_BOT_AGENT || `HerdrWeixinRelay/${pluginVersion}`),
    modelRole,
  };
}

function validateModelRole(role) {
  const roles = loadOmpModelRoles();
  if (roles[role]) return role;
  return "tiny";
}

export function ompAgentConfigPath() {
  return join(homedir(), ".omp", "agent", "config.yml");
}

export function loadOmpModelRoles() {
  const path = ompAgentConfigPath();
  try {
    const raw = readFileSync(path, "utf8");
    const roles = {};
    let inRoles = false;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("modelRoles:")) {
        inRoles = true;
        continue;
      }
      if (inRoles) {
        if (line.startsWith("  ") || line.startsWith("\t")) {
          const colon = trimmed.indexOf(":");
          if (colon > 0) {
            const role = trimmed.slice(0, colon).trim();
            const selector = trimmed.slice(colon + 1).trim();
            if (role && selector) roles[role] = selector;
          }
        } else if (trimmed) {
          break;
        }
      }
    }
    return roles;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export function modelSelectorForRole(role) {
  return loadOmpModelRoles()[role];
}

export function listModelRoles() {
  return Object.keys(loadOmpModelRoles());
}


export function normalizeTarget(value) {
  if (!value) return null;
  if (typeof value === "object" && value.target) {
    return { kind: value.kind === "pane" ? "pane" : "agent", target: String(value.target).trim() };
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith("pane:")) return { kind: "pane", target: raw.slice(5).trim() };
  if (raw.startsWith("agent:")) return { kind: "agent", target: raw.slice(6).trim() };
  return { kind: raw.includes(":") ? "pane" : "agent", target: raw };
}

export function targetFromContext(context) {
  const agent = String(context?.focused_pane_agent || context?.agent || "").trim();
  if (agent) return { kind: "agent", target: agent };
  const pane = String(context?.focused_pane_id || context?.pane_id || "").trim();
  if (pane) return { kind: "pane", target: pane };
  return null;
}

export function sanitizeBotAgent(raw) {
  const fallback = `HerdrWeixinRelay/${pluginVersion}`;
  if (!raw || typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const productRe = /^[A-Za-z0-9_.-]{1,32}\/[A-Za-z0-9_.+-]{1,32}$/;
  const commentRe = /^\([\x20-\x27\x2A-\x7E]{1,64}\)$/;
  const accepted = [];
  const parts = trimmed.split(/\s+/);
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    if (!productRe.test(token)) continue;
    if (i + 1 < parts.length && commentRe.test(parts[i + 1])) {
      accepted.push(`${token} ${parts[i + 1]}`);
      i += 1;
    } else {
      accepted.push(token);
    }
  }
  const joined = accepted.join(" ");
  return Buffer.byteLength(joined, "utf8") <= 256 && joined ? joined : fallback;
}

export function normalizeBaseUrl(value) {
  let baseUrl = String(value || "https://ilinkai.weixin.qq.com").trim();
  if (!baseUrl) baseUrl = "https://ilinkai.weixin.qq.com";
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`;
  return baseUrl.replace(/\/+$/, "");
}

export function truncateToBytes(text, maxBytes) {
  const source = String(text ?? "");
  if (Buffer.byteLength(source, "utf8") <= maxBytes) return source;
  let out = "";
  let used = 0;
  for (const char of source) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

export function chunkTextByBytes(text, maxBytes) {
  const chunks = [];
  let remaining = String(text ?? "");
  while (remaining) {
    const chunk = truncateToBytes(remaining, maxBytes);
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks.length ? chunks : [""];
}

export function extractTextItems(message) {
  const items = Array.isArray(message?.item_list) ? message.item_list : [];
  const texts = [];
  const media = [];
  for (const item of items) {
    if (item?.type === 1 && item?.text_item?.text) texts.push(String(item.text_item.text));
    else if (item?.type && item.type !== 1) media.push(item.type);
  }
  return { text: texts.join("\n").trim(), mediaTypes: media };
}

export function extractAssistantText(event) {
  const message = event?.type === "message" ? event.message : event;
  if (message?.role !== "assistant") return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function readJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid ${name}: ${error.message}`);
  }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
        }, options.timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 127, stdout, stderr: stderr + error.message });
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status: status ?? (signal ? 128 : 1), stdout, stderr, signal });
    });
  });
}

export function runCommandSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
  });
}

export function pidPath() {
  return join(stateDir(), "service.pid");
}

export function logPath() {
  return join(stateDir(), "service.log");
}

export function writePidFile(pid = process.pid) {
  atomicWrite(pidPath(), `${pid}\n`, 0o600);
}

export function readPidFile() {
  try {
    const pid = Number.parseInt(readFileSync(pidPath(), "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function openLogFd() {
  ensureDirs();
  return openSync(logPath(), "a", 0o600);
}

export function closeFd(fd) {
  try {
    closeSync(fd);
  } catch {}
}


export async function ensureWorkspace(label = "Weixin Relay") {
  const settings = loadSettings();
  const existing = await findWorkspace(label);
  if (existing) return workspaceId(existing);

  const created = await runCommand(settings.herdrBin, ["workspace", "create", "--label", label, "--no-focus"], { timeoutMs: 5000 });
  if (created.status !== 0) throw new Error(`workspace create failed: ${created.stderr || created.stdout || created.status}`);

  const found = await findWorkspace(label);
  const id = workspaceId(found);
  if (!id) throw new Error(`workspace ${label} was created but could not be found`);
  return id;
}

export async function ensureWeChatSessionPane({ label = "WeChat", agentName = "WeChat" } = {}) {
  const settings = loadSettings();
  const workspace = await ensureWorkspace();
  const paneList = await runCommand(settings.herdrBin, ["pane", "list"], { timeoutMs: 10_000 });
  if (paneList.status !== 0) throw new Error(`pane list failed: ${paneList.stderr || paneList.stdout || paneList.status}`);
  const paneData = parseJsonCommand(paneList.stdout, "pane list");
  const panes = Array.isArray(paneData?.result?.panes) ? paneData.result.panes : [];
  const existing = panes.find((p) => p.workspace_id === workspace && (p.label === label || p.name === agentName || p.agent === agentName));
  if (existing) return existing.pane_id;

  const modelSelector = modelSelectorForRole(settings.modelRole);
  const ompArgs = ["omp", "--cwd", pluginRoot];
  if (modelSelector) ompArgs.push("--model", modelSelector);
  const result = await runCommand(settings.herdrBin, [
    "agent", "start", agentName,
    "--workspace", workspace,
    "--split", "right",
    "--focus",
    "--", ...ompArgs,
  ], { timeoutMs: 15_000 });
  if (result.status !== 0) throw new Error(`WeChat session pane creation failed: ${result.stderr || result.stdout || result.status}`);
  const started = parseJsonCommand(result.stdout, "agent start");
  return started?.result?.agent?.pane_id || started?.result?.pane_id;
}

export async function openPaneInWorkspace({ entrypoint, placement = "tab", workspaceId }) {
  if (!entrypoint) throw new Error("entrypoint is required");
  if (!workspaceId) throw new Error("workspaceId is required");
  const settings = loadSettings();
  const result = await runCommand(settings.herdrBin, [
    "plugin",
    "pane",
    "open",
    "--plugin",
    pluginId,
    "--entrypoint",
    entrypoint,
    "--placement",
    placement,
    "--workspace",
    workspaceId,
    "--focus",
  ], { timeoutMs: 5000 });
  if (result.status !== 0) throw new Error(`pane open failed: ${result.stderr || result.stdout || result.status}`);
  return result.stdout.trim();
}

async function findWorkspace(label) {
  const settings = loadSettings();
  const result = await runCommand(settings.herdrBin, ["workspace", "list"], { timeoutMs: 5000 });
  if (result.status !== 0) throw new Error(`workspace list failed: ${result.stderr || result.stdout || result.status}`);
  const parsed = parseJsonCommand(result.stdout, "workspace list");
  const workspaces = Array.isArray(parsed?.result?.workspaces)
    ? parsed.result.workspaces
    : Array.isArray(parsed?.workspaces)
      ? parsed.workspaces
      : Array.isArray(parsed)
        ? parsed
        : [];
  return workspaces.find((workspace) => workspace?.label === label) || null;
}

function workspaceId(workspace) {
  return workspace?.workspace_id || workspace?.id || "";
}

function parseJsonCommand(stdout, label) {
  try {
    return JSON.parse(stdout || "{}");
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

export async function postToService(path, body = {}) {
  const settings = loadSettings();
  const token = readOrCreateControlToken();
  const response = await fetch(`http://127.0.0.1:${settings.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return parseServiceResponse(response);
}

export async function getServiceHealth() {
  const settings = loadSettings();
  const token = readOrCreateControlToken();
  const response = await fetch(`http://127.0.0.1:${settings.port}/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return parseServiceResponse(response);
}

async function parseServiceResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) throw new Error(data?.error || `${response.status} ${response.statusText}`);
  return data;
}
