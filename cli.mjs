#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  atomicWrite,
  closeFd,
  configDir,
  ensureDirs,
  ensureWeChatSessionPane,
  ensureWorkspace,
  getServiceHealth,
  isProcessAlive,
  lastContact,
  listModelRoles,
  loadAccount,
  loadSettings,
  logPath,
  modelSelectorForRole,
  normalizeBaseUrl,
  openLogFd,
  openPaneInWorkspace,
  pidPath,
  pluginRoot,
  postToService,
  readJsonEnv,
  readPidFile,
  removeFile,
  runCommandSync,
  saveAccount,
  setDefaultTarget,
  stateDir,
  targetFromContext,
} from "./lib.mjs";
import { checkNetwork, DEFAULT_BASE_URL, DEFAULT_BOT_TYPE, fetchQrCode, pollQrStatus } from "./ilink.mjs";

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

try {
  ensureDirs();
  seedEnvExample();
  switch (command) {
    case "login":
      await login();
      break;
    case "open-login":
      await openLoginPane();
      break;
    case "setup":
      await setup();
      break;
    case "start":
      await start();
      break;
    case "stop":
      await stop();
      break;
    case "status":
      await status();
      break;
    case "target-current":
      await targetCurrent();
      break;
    case "ensure-session":
      await ensureSession();
      break;
    case "model-roles":
      await listModelRolesCommand();
      break;
    case "set-model-role":
      await setModelRole(args[0]);
      break;
    case "send":
      await sendManual(args);
      break;
    case "send-test":
      await sendTest();
      break;
    case "logs":
      await logs();
      break;
    case "doctor":
      await doctor();
      break;
    default:
      help();
      process.exit(command === "help" ? 0 : 2);
  }
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(1);
}

function seedEnvExample() {
  const envPath = join(configDir(), ".env");
  if (existsSync(envPath)) return;
  const example = join(pluginRoot, ".env.example");
  if (existsSync(example)) writeFileSync(envPath, readFileSync(example, "utf8"), { mode: 0o600 });
}

function help() {
  console.log(`Usage: node cli.mjs <command>

Commands:
  login             QR login in the current terminal/pane
  open-login        open QR login in the Weixin Relay workspace
  setup             create/focus the Weixin Relay workspace
  start             start the daemon and open the logs pane
  stop              stop the Weixin relay daemon
  status            show daemon/account/target status
  target-current    save the current Herdr pane/agent as inbound target
  ensure-session    create/focus the dedicated WeChat session pane and set it as target
  model-roles       list available OMP model roles
  set-model-role    set the default model role for the WeChat session pane
  send <user> <txt> send text to a WeChat user id
  send-test         send a test to the last inbound WeChat sender
  logs              tail/poll the daemon log and health
  doctor            test network reachability to ilinkai.weixin.qq.com`);
}

async function setup() {
  const workspaceId = await ensureWorkspace("Weixin Relay");
  const settings = loadSettings();
  runCommandSync(settings.herdrBin, ["workspace", "focus", workspaceId], { timeoutMs: 5000 });
  console.log(`Weixin Relay workspace: ${workspaceId}`);
}

async function openLoginPane() {
  const workspaceId = await ensureWorkspace("Weixin Relay");
  await openPaneInWorkspace({ entrypoint: "login", placement: "tab", workspaceId });
  console.log("Opened WeChat QR login in the Weixin Relay workspace.");
}

async function login() {
  const existing = loadAccount();
  const localTokenList = existing?.token ? [existing.token] : [];
  console.log("Requesting WeChat QR login...");
  const qr = await fetchQrCode({ localTokenList, botType: DEFAULT_BOT_TYPE });
  if (!qr?.qrcode || !qr?.qrcode_img_content) throw new Error("QR response missing qrcode or qrcode_img_content");
  console.log("Scan this link with WeChat. If your terminal renders URLs, Ctrl-click it:");
  console.log(qr.qrcode_img_content);
  console.log("Waiting for confirmation. If WeChat shows a numeric verification code, type it here and press Enter.");

  let baseUrl = DEFAULT_BASE_URL;
  let verifyCode = "";
  let scannedPrinted = false;
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const status = await pollQrStatus({ baseUrl, qrcode: qr.qrcode, verifyCode });
    switch (status.status) {
      case "wait":
        process.stdout.write(".");
        break;
      case "scaned":
        if (!scannedPrinted) {
          process.stdout.write("\nScanned; waiting for confirmation.\n");
          scannedPrinted = true;
        }
        verifyCode = "";
        break;
      case "need_verifycode":
        verifyCode = await readLine("\nVerification code: ");
        break;
      case "verify_code_blocked":
        throw new Error("Verification code was rejected too many times; restart login later.");
      case "expired":
        throw new Error("QR code expired; run login again.");
      case "binded_redirect":
        console.log("\nThis WeChat bot is already bound; keeping existing local credentials.");
        return;
      case "scaned_but_redirect":
        if (status.redirect_host) baseUrl = normalizeBaseUrl(status.redirect_host);
        break;
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) throw new Error("Login confirmed but token/account id was missing.");
        saveAccount({
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id || "",
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
        });
        console.log("\nLogin saved. Token is stored in the plugin state dir with 0600 permissions.");
        return;
      }
      default:
        console.log(`\nStatus: ${status.status || "unknown"}`);
    }
    await sleep(1000);
  }
  throw new Error("Timed out waiting for QR confirmation.");
}

function readLine(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let input = "";
    const onData = (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(input.trim());
    };
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
}

async function start() {
  const existingPid = readPidFile();
  if (isProcessAlive(existingPid)) {
    console.log(`Relay daemon already running pid=${existingPid}`);
  } else {
    removeFile(pidPath());
    const fd = openLogFd();
    const child = (await import("node:child_process")).spawn(process.execPath, [join(pluginRoot, "service.mjs")], {
      cwd: pluginRoot,
      detached: true,
      env: { ...process.env, HERDR_WEIXIN_CONFIG_DIR: configDir(), HERDR_WEIXIN_STATE_DIR: stateDir() },
      stdio: ["ignore", fd, fd],
    });
    child.unref();
    closeFd(fd);
    for (let i = 0; i < 20; i += 1) {
      await sleep(150);
      try {
        const health = await getServiceHealth();
        console.log(`Relay daemon started pid=${health.pid} port=${health.port}`);
        break;
      } catch {}
    }
  }
  const workspaceId = await ensureWorkspace("Weixin Relay");
  await openPaneInWorkspace({ entrypoint: "logs", placement: "tab", workspaceId });
  console.log("Opened logs pane in the Weixin Relay workspace.");
}

async function stop() {
  const pid = readPidFile();
  if (!pid || !isProcessAlive(pid)) {
    removeFile(pidPath());
    console.log("Relay daemon is not running.");
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 30; i += 1) {
    await sleep(100);
    if (!isProcessAlive(pid)) {
      removeFile(pidPath());
      console.log("Relay daemon stopped.");
      return;
    }
  }
  console.log(`Relay daemon pid=${pid} did not exit after SIGTERM.`);
}

async function status() {
  const pid = readPidFile();
  const account = loadAccount();
  const settings = loadSettings();
  console.log(`Config dir: ${configDir()}`);
  console.log(`State dir: ${stateDir()}`);
  console.log(`Log: ${logPath()}`);
  console.log(`Account: ${account?.accountId ? "configured" : "missing"}`);
  console.log(`Target: ${settings.target ? `${settings.target.kind}:${settings.target.target}` : "unset"}`);
  console.log(`Model role: ${settings.modelRole}`);
  console.log(`PID file: ${pid || "none"} (${isProcessAlive(pid) ? "alive" : "not running"})`);
  try {
    const health = await getServiceHealth();
    console.log(`Health: ok pid=${health.pid} polling=${health.polling} lastPoll=${health.lastPollAt || "never"}`);
  } catch (error) {
    console.log(`Health: unavailable (${error.message})`);
  }
}

async function targetCurrent() {
  const context = readJsonEnv("HERDR_PLUGIN_CONTEXT_JSON");
  const target = targetFromContext(context);
  if (!target) throw new Error("No focused Herdr pane or agent was present in HERDR_PLUGIN_CONTEXT_JSON.");
  setDefaultTarget(target);
  console.log(`Inbound WeChat messages will route to ${target.kind}:${target.target}`);
}

async function ensureSession() {
  const paneId = await ensureWeChatSessionPane();
  const target = { kind: "pane", target: paneId };
  setDefaultTarget(target);
  console.log(`WeChat session pane: ${paneId}`);
  const settings = loadSettings();
  console.log(`Default target: ${settings.target.kind}:${settings.target.target}`);
  console.log(`Model role: ${settings.modelRole}`);
}

async function listModelRolesCommand() {
  const roles = listModelRoles();
  const settings = loadSettings();
  console.log("Available OMP model roles:");
  for (const role of roles) {
    const marker = role === settings.modelRole ? " (current)" : "";
    const selector = modelSelectorForRole(role) || "";
    console.log(`  ${role}${marker}${selector ? ` — ${selector}` : ""}`);
  }
}

async function setModelRole(role) {
  if (!role) throw new Error("Usage: node cli.mjs set-model-role <role>");
  const roles = listModelRoles();
  if (!roles.includes(role)) throw new Error(`Unknown role: ${role}. Available: ${roles.join(", ")}`);
  const envPath = join(configDir(), ".env");
  let content = "";
  try {
    content = readFileSync(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const lines = content.split("\n").filter((line) => !line.startsWith("HERDR_WEIXIN_MODEL_ROLE="));
  lines.push(`HERDR_WEIXIN_MODEL_ROLE=${role}`);
  atomicWrite(envPath, `${lines.filter(Boolean).join("\n")}\n`, 0o600);
  console.log(`Default model role set to ${role}. New WeChat session panes will use this role.`);
}

async function sendManual(argv) {
  const [toUserId, ...textParts] = argv;
  const text = textParts.join(" ").trim();
  if (!toUserId || !text) throw new Error("Usage: node cli.mjs send <weixin_user_id> <text>");
  const result = await postToService("/send", { toUserId, text });
  console.log(`Sent ${result.chunks} chunk(s).`);
}

async function sendTest() {
  const contact = lastContact();
  if (!contact?.userId) throw new Error("No inbound WeChat contact yet; send a message to the relay first.");
  const result = await postToService("/send", {
    toUserId: contact.userId,
    text: "Herdr Weixin relay test message.",
  });
  console.log(`Sent test to last contact in ${result.chunks} chunk(s).`);
}

async function logs() {
  const { createReadStream } = await import("node:fs");
  const { stat } = await import("node:fs/promises");
  const logFile = logPath();
  let position = 0;
  try {
    position = (await stat(logFile)).size;
  } catch {}
  while (true) {
    try {
      const health = await getServiceHealth();
      console.log(`[health] pid=${health.pid} polling=${health.polling} lastPoll=${health.lastPollAt || "never"} account=${health.accountConfigured} target=${health.targetConfigured}`);
    } catch (error) {
      console.log(`[health] ${error.message}`);
    }
    try {
      const s = await stat(logFile);
      if (s.size > position) {
        const stream = createReadStream(logFile, { start: position, end: s.size });
        for await (const chunk of stream) process.stdout.write(chunk);
        position = s.size;
      }
    } catch (error) {
      console.log(`[log error] ${error.message}`);
    }
    await sleep(2000);
  }
}

async function doctor() {
  console.log(`Node: ${process.version}`);
  console.log(`Herdr: ${herdrVersion()}`);
  console.log(`Config dir: ${configDir()}`);
  console.log(`State dir: ${stateDir()}`);
  const network = await checkNetwork();
  console.log(`iLink network: reachable HTTP ${network.status}`);
}

function herdrVersion() {
  const settings = loadSettings();
  const result = runCommandSync(settings.herdrBin, ["--version"], { timeoutMs: 5000 });
  return result.status === 0 ? result.stdout.trim() : `unavailable (${result.stderr.trim() || result.status})`;
}
