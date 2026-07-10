# Herdr Weixin Relay

Local Herdr plugin plus PID-file Node daemon for relaying personal WeChat text messages through Tencent's `ilink` bot protocol, modeled from `Tencent/openclaw-weixin` 2.4.6.

## Files

- `herdr-plugin.toml` — Herdr actions.
- `cli.mjs` — thin action/management CLI.
- `service.mjs` — local long-poll daemon.
- `ilink.mjs` — QR login, `getupdates`, and text `sendmessage` protocol calls.
- `lib.mjs` — config/state, PID, target, and Herdr helpers.
- `check.mjs` — local protocol self-check with a fake ilink server.

## Setup

```sh
herdr plugin link /home/nicholas/Sync/shared/herdr/plugins/herdr-weixin-relay
herdr plugin action invoke local.herdr-weixin-relay.doctor
herdr plugin action invoke local.herdr-weixin-relay.target-current
herdr plugin action invoke local.herdr-weixin-relay.login  # opens an interactive QR-login pane
herdr plugin action invoke local.herdr-weixin-relay.start
```

If you prefer a normal terminal pane instead of the plugin overlay, run:

```sh
cd /home/nicholas/Sync/shared/herdr/plugins/herdr-weixin-relay
node cli.mjs login
```

The plugin seeds editable config at:

```text
~/.config/herdr/plugins/config/local.herdr-weixin-relay/.env
```

Credentials and sync cursor are stored locally at:

```text
~/.local/state/herdr/plugins/local.herdr-weixin-relay/
```

Do not sync or publish that state directory.

## Actions

- `doctor` — checks Node, Herdr, config/state paths, and network reachability to `ilinkai.weixin.qq.com`.
- `login` — opens an interactive pane that starts QR login and saves the returned ilink bot token.
- `target-current` — saves the focused Herdr agent/pane as the inbound WeChat target.
- `start` — starts the PID-file daemon.
- `stop` — stops the daemon.
- `status` — prints config, account, target, PID, and health.
- `send-test` — sends a test message to the last inbound WeChat sender.

Inbound text messages are forwarded as `[WeChat <userId>] <message>` to the configured target. For pane targets, the daemon does not append a newline, so it will not execute text in a shell. For agent targets, it appends a newline so the message is submitted.

## WeChat commands

Send these from WeChat after login:

- `/help`
- `/status`
- `/target`
- `/target agent:<name-or-label>`
- `/target pane:<pane-id>`

## Verification

```sh
node check.mjs
herdr plugin action invoke local.herdr-weixin-relay.doctor
herdr plugin action invoke local.herdr-weixin-relay.status
herdr plugin action invoke local.herdr-weixin-relay.start
herdr plugin action invoke local.herdr-weixin-relay.status
herdr plugin action invoke local.herdr-weixin-relay.stop
```
