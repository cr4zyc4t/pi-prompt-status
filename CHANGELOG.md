# Changelog

## 0.1.0

- Initial release: one status line per response, written as a durable `prompt-status` custom
  session entry when the agent settles.
- Fields: response duration, finish time (`HH:MM:SS`), TTFT, tokens/s, sent tokens, received
  tokens, and cache hit rate, each formatted in human-friendly units.
- Aggregates every provider request, tool call, retry, and queued continuation between prompt
  submit and `agent_settled`.
- Expanded transcript view (`ctrl+o`) adds request count, streaming window, generation-only
  rate, uncached input, cache writes, nested tool usage, and models used.
- `/prompt-status` with `on|off`, `mode`, `fields`, `footer`, `nested`, `cache`, `aborted`,
  `last`, `stats`, `path`, `reset`; settings persist to `~/.pi/agent/prompt-status.json`.
