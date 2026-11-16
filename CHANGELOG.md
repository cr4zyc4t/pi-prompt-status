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

## Unreleased

- Generation mode now divides by the decode window whenever it is nonzero; previously any response whose
  streaming windows summed to 250 ms or less silently fell back to wall duration, understating tokens/s.
- A cost total that includes a catalog estimate is marked `~$` even when the model's own requests were
  provider-billed, which happens when nested tool usage is folded into `cost`.
- `sentIncludesCache: off` now excludes nested cache tokens as well, instead of only the model's own.
- `/prompt-status last` and the settings summary read the durable session entries, so they still report after
  `/reload`, `/resume`, `/fork`, and `/tree` instead of claiming nothing was recorded.
- `/prompt-status footer off` clears the line the mirror left in the footer.
- A field argument list made up entirely of unknown names now names the rejected tokens.
- Expanded rendering no longer throws on a version-1 entry written without a `models` list.
- Docs: eight default fields (not seven), install commands that work from the checkout, when the config file
  appears and what invalid JSON does, and the exact channel nested tool usage is counted from.
- Tests: `test/extension.test.mjs` drives the real handlers, renderer, and commands through a fake
  `ExtensionAPI` with no provider; the RPC smoke test now proves it aborted mid-stream, always reaps the
  pi process, skips with exit 2 when no auth is available, and checks `stats` against its documented shape.
