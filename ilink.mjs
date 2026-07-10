import crypto from "node:crypto";
import { loadSettings, normalizeBaseUrl, openClawWeixinVersion, pluginVersion } from "./lib.mjs";

// Protocol constants and request shape are derived from Tencent/openclaw-weixin 2.4.6 (MIT).
// This file keeps the ilink_appid "bot" and client-version encoding required by that backend.
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_BOT_TYPE = "3";
export const ILINK_APP_ID = "bot";
export const ILINK_APP_CLIENT_VERSION = buildClientVersion(openClawWeixinVersion);

const API_TIMEOUT_MS = 15_000;
const QR_POLL_TIMEOUT_MS = 35_000;
const GET_UPDATES_TIMEOUT_MS = 35_000;

export function buildClientVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

function commonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

function authHeaders(token) {
  const headers = {
    "content-type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

export function buildBaseInfo(settings = loadSettings()) {
  return {
    channel_version: `${pluginVersion}-openclaw-weixin-${openClawWeixinVersion}`,
    bot_agent: settings.botAgent,
  };
}

function endpointUrl(baseUrl, endpoint) {
  return new URL(endpoint.replace(/^\/+/, ""), `${normalizeBaseUrl(baseUrl)}/`).toString();
}

async function apiGet({ baseUrl = DEFAULT_BASE_URL, endpoint, timeoutMs = API_TIMEOUT_MS }) {
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const response = await fetch(endpointUrl(baseUrl, endpoint), {
      method: "GET",
      headers: commonHeaders(),
      signal: controller?.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GET ${endpoint} ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function apiPost({ baseUrl = DEFAULT_BASE_URL, endpoint, token, body, timeoutMs = API_TIMEOUT_MS, abortSignal }) {
  const controller = timeoutMs > 0 ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const onAbort = () => controller?.abort();
  if (abortSignal?.aborted) controller?.abort();
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(endpointUrl(baseUrl, endpoint), {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`POST ${endpoint} ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchQrCode({ baseUrl = DEFAULT_BASE_URL, localTokenList = [], botType = DEFAULT_BOT_TYPE } = {}) {
  return apiPost({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    body: { local_token_list: localTokenList.slice(0, 10) },
    timeoutMs: API_TIMEOUT_MS,
  });
}

export async function pollQrStatus({ baseUrl = DEFAULT_BASE_URL, qrcode, verifyCode = "" }) {
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
  return apiGet({ baseUrl, endpoint, timeoutMs: QR_POLL_TIMEOUT_MS });
}

export async function getUpdates({ account, syncBuf = "", timeoutMs = GET_UPDATES_TIMEOUT_MS, abortSignal }) {
  try {
    return await apiPost({
      baseUrl: account.baseUrl || DEFAULT_BASE_URL,
      endpoint: "ilink/bot/getupdates",
      token: account.token,
      timeoutMs,
      body: {
        get_updates_buf: syncBuf || "",
        base_info: buildBaseInfo(),
      },
      abortSignal,
    });
  } catch (error) {
    if (error?.name === "AbortError") return { ret: 0, msgs: [], get_updates_buf: syncBuf };
    throw error;
  }
}

export async function sendText({ account, toUserId, text, contextToken = "" }) {
  const clientId = `herdr-weixin-${crypto.randomUUID()}`;
  const response = await apiPost({
    baseUrl: account.baseUrl || DEFAULT_BASE_URL,
    endpoint: "ilink/bot/sendmessage",
    token: account.token,
    timeoutMs: API_TIMEOUT_MS,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: text ? [{ type: 1, text_item: { text } }] : undefined,
        context_token: contextToken || undefined,
      },
      base_info: buildBaseInfo(),
    },
  });
  if (response.ret && response.ret !== 0) {
    throw new Error(`sendmessage ret=${response.ret} errmsg=${response.errmsg || "(none)"}`);
  }
  return { clientId, response };
}

export async function checkNetwork() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(DEFAULT_BASE_URL, { method: "GET", signal: controller.signal });
    return { ok: true, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}
