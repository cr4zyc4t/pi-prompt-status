# Changelog

## 0.1.0

- Initial release: one status line per response, written as a durable `prompt-status` custom
  session entry when the agent settles.
- Fields: finish time (`HH:MM:SS`), response duration, TTFT, tokens/s, sent tokens, received
  tokens, cache hit rate, and cost, each formatted in human-friendly units; `↑`/`↓` carry no label.
- Cost shows the provider-billed figure as `$0.0043` and pi's catalog estimate as `~$0.0043`, and hides itself
  for models without pricing data and for totals that are zero.
- Order and per-field visibility are configurable (`fields` + `hidden` in config, or
  `/prompt-status order|fields|show|hide`).
- Aggregates every provider request, tool call, retry, and queued continuation between prompt
  submit and `agent_settled`.
- Expanded transcript view (`ctrl+o`) adds request count, streaming window, generation-only
  rate, uncached input, cache writes, nested tool usage, and models used.
- `/prompt-status` with `on|off`, `order`, `fields`, `show`, `hide`, `mode`, `footer`, `nested`,
  `cache`, `aborted`, `last`, `stats`, `path`, `reset`; settings persist to
  `~/.pi/agent/prompt-status.json`.
- MIT licensed (`LICENSE`).
