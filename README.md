# Herdr Weixin Relay

Local Herdr plugin + PID-file Node daemon for relaying personal WeChat text messages through Tencent's `ilink` bot protocol, modeled from `Tencent/openclaw-weixin` 2.4.6. It can forward inbound WeChat text to Herdr panes/agents; automatic assistant replies back to WeChat currently require an OMP-backed agent session.

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
- `TODO.md` — deferred compatibility and response-adapter work.
- `README.md` — this file.

### Quick start

```sh
herdr plugin link /path/to/herdr-weixin-relay
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
- `ensure-session` — creates or focuses the dedicated OMP-backed `WeChat` agent pane and saves it as the inbound target.
- `model-roles` — lists OMP model roles available for the dedicated WeChat session pane.
- `start` — starts the PID-file daemon and opens the logs pane in the `Weixin Relay` workspace.
- `stop` — stops the daemon.
- `status` — prints config, account, target, PID, model role, and health.
- `send-test` — sends a test message to the last inbound WeChat sender.

### Manual terminal login

If you prefer a normal terminal pane instead of the plugin tab:

```sh
cd /path/to/herdr-weixin-relay
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

Set `HERDR_WEIXIN_MODEL_ROLE` in that `.env` to choose the OMP model role used when the daemon creates the dedicated `WeChat` agent pane. Use `node cli.mjs model-roles` to list valid roles and `node cli.mjs set-model-role <role>` to update the plugin config from a terminal.

### How messages work

Inbound text messages are forwarded as `[WeChat <userId>] <message>` to the configured target. Plain pane targets receive text without submitting it. Agent targets use `herdr agent send`; pane targets that host an agent receive the text and a Return keypress so the message is submitted. For OMP-backed agent targets, the daemon watches the OMP session JSONL and sends the next assistant text response back to the originating WeChat user.

### Compatibility

The WeChat login, long polling, outbound `send-test`, and basic WeChat-to-Herdr forwarding are not inherently tied to OMP. Automatic response bridging **is OMP-specific today**: the daemon discovers the target's OMP session JSONL through Herdr metadata and parses OMP `assistant` message events. Other tools can still receive inbound WeChat text in a pane, but they will not automatically reply back to WeChat unless an adapter is added for that tool's response stream/schema. See `TODO.md` for the deferred adapter plan.

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
Local Herdr 插件 + PID 文件 Node 守护进程，通过腾讯 `ilink` bot 协议转发个人微信文本消息，参考 `Tencent/openclaw-weixin` 2.4.6 实现。它可以将入站微信文本转发到 Herdr 面板/代理；自动将助手回复发回微信目前需要 OMP 支持的代理会话。

### 文件

- `herdr-plugin.toml` — Herdr 动作与面板配置。
- `cli.mjs` — 轻量级动作/管理 CLI。
- `service.mjs` — 本地长轮询守护进程。
- `ilink.mjs` — 二维码登录、`getupdates` 和文本 `sendmessage` 协议调用。
- `lib.mjs` — 配置/状态、PID、目标、工作区与 Herdr 辅助函数。
- `check.mjs` — 使用伪造 ilink 服务器进行本地协议自检。
- `TODO.md` — 延后的兼容性与响应适配器工作。
- `README.md` — 本文件。

### 快速开始

```sh
herdr plugin link /path/to/herdr-weixin-relay
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
- `ensure-session` — 创建或聚焦专用的 OMP 支持的 `WeChat` 代理面板，并将其保存为入站目标。
- `model-roles` — 列出专用微信会话面板可用的 OMP 模型角色。
- `start` — 启动 PID 文件守护进程，并在 `Weixin Relay` 工作区打开日志面板。
- `stop` — 停止守护进程。
- `status` — 打印配置、账户、目标、PID、模型角色和健康状态。
- `send-test` — 向上一次发信给你的微信联系人发送测试消息。

### 手动终端登录

如果你更喜欢在普通终端面板中操作：

```sh
cd /path/to/herdr-weixin-relay
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

在该 `.env` 中设置 `HERDR_WEIXIN_MODEL_ROLE` 可选择守护进程创建专用 `WeChat` 代理面板时使用的 OMP 模型角色。使用 `node cli.mjs model-roles` 列出可用角色，或在终端中运行 `node cli.mjs set-model-role <角色>` 更新插件配置。

### 消息转发机制

入站文本消息会以 `[WeChat <userId>] <message>` 格式转发到配置目标。普通面板目标只接收文本，不会提交执行；代理目标通过 `herdr agent send` 发送；承载代理的面板目标会接收文本并发送 Return 键，以便消息被提交。对于 OMP 支持的代理目标，守护进程会监听 OMP 会话 JSONL，并将下一条助手文本回复发回原微信用户。

### 兼容性

微信登录、长轮询、出站 `send-test` 和基础的微信到 Herdr 转发并不天然绑定 OMP。自动回复桥接**目前是 OMP 专用**：守护进程通过 Herdr 元数据找到目标的 OMP 会话 JSONL，并解析 OMP 的 `assistant` 消息事件。其他工具仍然可以在面板中接收入站微信文本，但除非为该工具的响应流/数据结构添加适配器，否则不会自动把回复发回微信。延后的适配器计划见 `TODO.md`。

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
