# Herdr Weixin Relay

Local Herdr plugin + PID-file Node daemon for relaying personal WeChat text messages through Tencent's `ilink` bot protocol, modeled from `Tencent/openclaw-weixin` 2.4.6.

**Toggle / 切换语言**:
- [English](#english)
- [中文](#中文)

---

## English

### Files

- `herdr-plugin.toml` — Herdr actions and panes.
- `cli.mjs` — thin action/management CLI.
- `service.mjs` — local long-poll daemon.
- `ilink.mjs` — QR login, `getupdates`, and text `sendmessage` protocol calls.
- `lib.mjs` — config/state, PID, target, workspace, and Herdr helpers.
- `check.mjs` — local protocol self-check with a fake ilink server.
- `README.md` — this file.

### Quick start

```sh
herdr plugin link /mnt/qm2/toys/herdr-weixin-relay
herdr plugin action invoke local.herdr-weixin-relay.doctor
herdr plugin action invoke local.herdr-weixin-relay.setup        # create/focus Weixin Relay workspace
herdr plugin action invoke local.herdr-weixin-relay.target-current
herdr plugin action invoke local.herdr-weixin-relay.login         # opens QR-login pane in the Weixin Relay workspace
herdr plugin action invoke local.herdr-weixin-relay.start
```

### Actions

- `doctor` — checks Node, Herdr, config/state paths, and network reachability to `ilinkai.weixin.qq.com`.
- `setup` — creates or focuses the dedicated `Weixin Relay` Herdr workspace.
- `login` — opens a tab in the `Weixin Relay` workspace with a live QR login and verification prompt.
- `target-current` — saves the focused Herdr agent/pane as the inbound WeChat target.
- `start` — starts the PID-file daemon and opens the logs pane in the `Weixin Relay` workspace.
- `stop` — stops the daemon.
- `status` — prints config, account, target, PID, and health.
- `send-test` — sends a test message to the last inbound WeChat sender.

### Manual terminal login

If you prefer a normal terminal pane instead of the plugin tab:

```sh
cd /mnt/qm2/toys/herdr-weixin-relay
node cli.mjs login
```

### Config and state

The plugin seeds editable config at:

```text
~/.config/herdr/plugins/config/local.herdr-weixin-relay/.env
```

Credentials and sync cursor are stored locally at:

```text
~/.local/state/herdr/plugins/local.herdr-weixin-relay/
```

Do not sync or publish that state directory.

### How messages work

Inbound text messages are forwarded as `[WeChat <userId>] <message>` to the configured target. For pane targets, the daemon does not append a newline, so it will not execute text in a shell. For agent targets, it appends a newline so the message is submitted.

### WeChat commands

Send these from WeChat after login:

- `/help`
- `/status`
- `/target`
- `/target agent:<name-or-label>`
- `/target pane:<pane-id>`

### Verification

```sh
node check.mjs
herdr plugin action invoke local.herdr-weixin-relay.doctor
herdr plugin action invoke local.herdr-weixin-relay.status
herdr plugin action invoke local.herdr-weixin-relay.start
herdr plugin action invoke local.herdr-weixin-relay.status
herdr plugin action invoke local.herdr-weixin-relay.stop
```

---

## 中文

### 文件

- `herdr-plugin.toml` — Herdr 动作与面板配置。
- `cli.mjs` — 轻量级动作/管理 CLI。
- `service.mjs` — 本地长轮询守护进程。
- `ilink.mjs` — 二维码登录、`getupdates` 和文本 `sendmessage` 协议调用。
- `lib.mjs` — 配置/状态、PID、目标、工作区与 Herdr 辅助函数。
- `check.mjs` — 使用伪造 ilink 服务器进行本地协议自检。
- `README.md` — 本文件。

### 快速开始

```sh
herdr plugin link /mnt/qm2/toys/herdr-weixin-relay
herdr plugin action invoke local.herdr-weixin-relay.doctor
herdr plugin action invoke local.herdr-weixin-relay.setup        # 创建或聚焦 Weixin Relay 工作区
herdr plugin action invoke local.herdr-weixin-relay.target-current
herdr plugin action invoke local.herdr-weixin-relay.login         # 在 Weixin Relay 工作区打开二维码登录面板
herdr plugin action invoke local.herdr-weixin-relay.start
```

### 动作

- `doctor` — 检查 Node、Herdr、配置/状态路径以及到 `ilinkai.weixin.qq.com` 的网络可达性。
- `setup` — 创建或聚焦专用的 `Weixin Relay` Herdr 工作区。
- `login` — 在 `Weixin Relay` 工作区中打开一个标签页，显示实时二维码登录和验证码提示。
- `target-current` — 将当前聚焦的 Herdr 代理/面板保存为入站微信目标。
- `start` — 启动 PID 文件守护进程，并在 `Weixin Relay` 工作区打开日志面板。
- `stop` — 停止守护进程。
- `status` — 打印配置、账户、目标、PID 和健康状态。
- `send-test` — 向上一次发信给你的微信联系人发送测试消息。

### 手动终端登录

如果你更喜欢在普通终端面板中操作：

```sh
cd /mnt/qm2/toys/herdr-weixin-relay
node cli.mjs login
```

### 配置与状态

插件会在以下位置生成可编辑配置：

```text
~/.config/herdr/plugins/config/local.herdr-weixin-relay/.env
```

凭据和同步游标存储在本地：

```text
~/.local/state/herdr/plugins/local.herdr-weixin-relay/
```

请勿同步或发布该状态目录。

### 消息转发机制

入站文本消息会以 `[WeChat <userId>] <message>` 格式转发到配置目标。面板目标不会追加换行符，因此不会在 shell 中执行文本；代理目标会追加换行符，以便消息被提交。

### 微信命令

登录后，从微信中发送以下命令：

- `/help`
- `/status`
- `/target`
- `/target agent:<名称或标签>`
- `/target pane:<面板ID>`

### 验证

```sh
node check.mjs
herdr plugin action invoke local.herdr-weixin-relay.doctor
herdr plugin action invoke local.herdr-weixin-relay.status
herdr plugin action invoke local.herdr-weixin-relay.start
herdr plugin action invoke local.herdr-weixin-relay.status
herdr plugin action invoke local.herdr-weixin-relay.stop
```
