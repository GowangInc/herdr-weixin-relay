# TODO

## Later: response adapters beyond OMP

Current automatic response bridging is OMP-specific because it watches OMP session JSONL exposed through Herdr `agent_session` metadata and parses OMP `assistant` message events.

Future work: make the response bridge adapter-based so other tools can opt in without pretending to be OMP.

- Split the current OMP JSONL parsing into a response adapter.
- Add `HERDR_WEIXIN_RESPONSE_ADAPTER=auto|omp|none`.
- Keep WeChat transport and Herdr forwarding generic.
- In `auto`, select an adapter from Herdr `agent_session.source` and session metadata.
- For unsupported tools, keep inbound forwarding but skip automatic WeChat replies with a clear log message.
- Add adapters only with real sanitized fixtures for each tool:
  - OpenCode
  - Claude Code
  - Pi
  - AGY
  - other Herdr-launched agents
- Each adapter needs fixture coverage for:
  - session path/source discovery
  - cursor/resume behavior
  - assistant/final-response detection
  - thinking/tool-call/result filtering
  - stable response IDs for duplicate prevention

Do not ship placeholder adapters. Unsupported tools should be explicit instead of silently mis-parsing transcripts.
