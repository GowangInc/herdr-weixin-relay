#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "herdr-weixin-relay-"));
process.env.HERDR_WEIXIN_CONFIG_DIR = join(tmp, "config");
process.env.HERDR_WEIXIN_STATE_DIR = join(tmp, "state");
process.env.HERDR_WEIXIN_BOT_AGENT = "HerdrWeixinRelay/0.1.0";

const lib = await import("./lib.mjs");
const ilink = await import("./ilink.mjs");

try {
  assert.equal(ilink.buildClientVersion("2.4.6"), 132102);
  assert.equal(ilink.ILINK_APP_ID, "bot");
  assert.equal(ilink.ILINK_APP_CLIENT_VERSION, 132102);
  assert.deepEqual(lib.normalizeTarget("pane:wN:p1"), { kind: "pane", target: "wN:p1" });
  assert.deepEqual(lib.normalizeTarget("agent:omp"), { kind: "agent", target: "omp" });
  assert.equal(lib.truncateToBytes("ab中文", 4), "ab");
  assert.deepEqual(lib.extractTextItems({ item_list: [{ type: 1, text_item: { text: "hi" } }, { type: 2 }] }), { text: "hi", mediaTypes: [2] });
  assert.equal(lib.extractAssistantText({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private scratchpad" },
        { type: "text", text: "reply one" },
        { type: "text", text: "reply two" },
      ],
    },
  }), "reply one\nreply two");

  const seen = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) : null;
    seen.push({ url: request.url, method: request.method, headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (request.url.startsWith("/ilink/bot/get_bot_qrcode")) {
      response.end(JSON.stringify({ qrcode: "qr-token", qrcode_img_content: "https://qr.example/scan" }));
      return;
    }
    if (request.url.startsWith("/ilink/bot/get_qrcode_status")) {
      response.end(JSON.stringify({ status: "confirmed", bot_token: "secret-token", ilink_bot_id: "bot-id", baseurl: baseUrl, ilink_user_id: "wx-user" }));
      return;
    }
    if (request.url === "/ilink/bot/getupdates") {
      response.end(JSON.stringify({ ret: 0, get_updates_buf: "buf2", longpolling_timeout_ms: 9000, msgs: [] }));
      return;
    }
    if (request.url === "/ilink/bot/sendmessage") {
      response.end(JSON.stringify({ ret: 0 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "missing" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const qr = await ilink.fetchQrCode({ baseUrl, localTokenList: ["old-token"] });
  assert.equal(qr.qrcode, "qr-token");
  const status = await ilink.pollQrStatus({ baseUrl, qrcode: "qr-token" });
  assert.equal(status.status, "confirmed");
  const account = { token: "secret-token", baseUrl, accountId: "bot-id" };
  const updates = await ilink.getUpdates({ account, syncBuf: "buf1", timeoutMs: 1000 });
  assert.equal(updates.get_updates_buf, "buf2");
  await ilink.sendText({ account, toUserId: "wx-user", text: "hello", contextToken: "ctx" });

  const qrReq = seen.find((item) => item.url.startsWith("/ilink/bot/get_bot_qrcode"));
  assert.equal(qrReq.headers["ilink-app-id"], "bot");
  assert.equal(qrReq.headers["ilink-app-clientversion"], "132102");
  assert.deepEqual(qrReq.body.local_token_list, ["old-token"]);
  const sendReq = seen.find((item) => item.url === "/ilink/bot/sendmessage");
  assert.equal(sendReq.headers.authorization, "Bearer secret-token");
  assert.equal(sendReq.body.msg.to_user_id, "wx-user");
  assert.equal(sendReq.body.msg.context_token, "ctx");
  assert.equal(sendReq.body.msg.message_type, 2);
  assert.equal(sendReq.body.msg.item_list[0].text_item.text, "hello");
  assert.equal(sendReq.body.base_info.bot_agent, "HerdrWeixinRelay/0.1.0");
  server.close();

  console.log("ok");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
