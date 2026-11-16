# pi-prompt-status

One status line per **response** in [pi](https://pi.dev), written into the transcript when the agent fully settles:

```
◷ 14:33:05 · ⏱ 1m20s · TTFT 0.83s · ⚡ 42 tok/s · ↑ 12.3k · ↓ 1.2k · cache 88% · ~$0.0043
```

A free or unpriced model simply ends at `cache 88%` — the cost field hides itself.

A response is the whole unit of work: **prompt submitted → agent settled**, so every provider request, tool call,
retry, compaction recovery, and queued continuation in between is measured as one thing.

| Field | Default | Example | Meaning |
| --- | --- | --- | --- |
| `finished` | ◷ | `◷ 14:33:05` | Local wall-clock time the response finished. |
| `duration` | `⏱` | `⏱ 1m20s` | Prompt submit → fully settled. Rendered `840ms` / `20s` / `1m20s` / `1h20m` / `2d3h`. |
| `ttft` | `TTFT` | `TTFT 0.83s` | Prompt submit → **first output token** of the response (text, thinking, or tool-call args). Includes queueing and prefill. `n/a` if no token arrived. |
| `tps` | `⚡` | `⚡ 42 tok/s` | Output tokens per second. Default divisor is the response duration; `mode generation` divides by streaming time only. |
| `sent` | `↑` | `↑ 12.3k` | Prompt tokens the provider was sent, summed over every request: `input + cache read + cache write`. |
| `recv` | `↓` | `↓ 1.2k` | Output tokens received, summed over every request. |
| `cache` | `cache` | `cache 88%` | `cache read / (input + cache read + cache write)` for the response. Never rounds a partial hit up to 100%; shows `<1%`, `0%`, or `n/a`. |
| `cost` | `$` | `~$0.0043` | Summed `usage.cost.total` over every request. `$` means the provider billed figure; `~$` means pi's catalog estimate. Hidden when the model has no pricing data **or** the total is zero, so free and unpriced models never show `$0`. |

Order and visibility are yours: `order` sets position, `show`/`hide` toggle each field, and each field keeps its own
icon. Only `tok/s` carries a word — sent and received read from their arrows alone.

Aborted runs (Escape) get an `aborted · ` prefix.

`ctrl+o` (expanded) adds a second line with the request count, streaming window, generation-only rate, uncached input,
cache writes, nested-tool usage, and the model(s) used:

```
req 4 · gen 24s · gen-only 142 tok/s · uncached ↑1.5k · cache w 2.1k · gpt-5.6-luna
```

## Install

Run these from the package checkout:

```bash
pi install npm:pi-prompt-status      # once published
pi install .                         # local checkout, personal scope
pi install -l .                      # project scope
pi -e ./extensions/prompt-status.ts  # try once, nothing written to settings
```

Then `/reload` if pi is already running.

## Where the status lives

The status is a `prompt-status` **custom session entry** (`pi.appendEntry`) with a registered entry renderer:

- durable — stays in the transcript and survives `/reload`, `/resume`, `/fork`, and `/tree`;
- TUI-only — custom entries never enter LLM context, and `/export`, `/copy`, `pi -p`, and `--mode json` message
  output stay clean;
- one entry per response, so history keeps every response's numbers, not just the last one.

## Configuration

`~/.pi/agent/prompt-status.json` (honors `PI_CODING_AGENT_DIR`). Every key is optional; unknown keys are ignored.

The file is not created by installing or running the extension: defaults apply until a `/prompt-status` setting command
writes it, and `/prompt-status path` prints where it would be. Invalid JSON is reported once and the defaults are used,
so a typo cannot silence the status line. Settings live per process, so with two pi sessions open the one that saves
last wins.

```json
{
  "enabled": true,
  "fields": ["finished", "duration", "ttft", "tps", "sent", "recv", "cache", "cost"],
  "hidden": [],
  "tpsMode": "response",
  "sentIncludesCache": true,
  "includeNestedUsage": false,
  "showAborted": true,
  "footerStatus": false,
  "nonInteractive": false
}
```

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Write status entries at all. |
| `fields` | the eight keys in the default order above | Render order. Anything left out is appended in default order, so a partial list is legal. |
| `hidden` | `[]` | Fields kept out of the line. They stay listed in `fields`, so re-showing them lands back in position. |
| `tpsMode` | `"response"` | `"response"`: `recv / duration`. `"generation"`: `recv / Σ streaming windows`, which excludes tool execution and inter-request gaps. |
| `sentIncludesCache` | `true` | Include cache read/write in `sent`. Cache hit % always uses all prompt tokens either way. |
| `includeNestedUsage` | `false` | Add nested usage to `sent`/`recv`, counted from what a tool returns in its `tool_result` `usage` field — the channel pi documents for nested LLM calls. A tool that reports child usage only in `details` contributes nothing here. |
| `showAborted` | `true` | Still write a status for runs aborted with Escape. |
| `footerStatus` | `false` | Also mirror the latest status into pi's footer until the next prompt. |
| `nonInteractive` | `false` | Also write entries in print/JSON mode, where there is no transcript to render into. |

## Command

`/prompt-status` — no argument shows current settings and the last status.

| Subcommand | Effect |
| --- | --- |
| `on` / `off` | Enable or disable the extension. |
| `order <a,b,c>` | Set render order. Unlisted fields keep their visibility and move to the end. |
| `fields <a,b,c>` | Render exactly these, in this order — everything else becomes hidden. |
| `show <a,b>` / `hide <a,b>` | Toggle fields without touching the order. |
| `mode response\|generation` | Choose the tokens/s denominator. |
| `footer on\|off` | Footer mirror. Turning it off also clears the line it left in the footer. |
| `nested on\|off` | Include nested tool usage in `sent`/`recv`. |
| `cache on\|off` | Whether `sent` includes cache tokens, for the model's own requests and for nested usage. |
| `aborted on\|off` | Write statuses for aborted runs. |
| `last` | Print the newest status again — read from the session entries, so it still works after `/reload` or `/resume`. |
| `stats` | Session totals: responses, wall time, streaming time, avg tok/s, avg cache hit, total sent/received, and cost. |
| `path` / `reset` | Print the config path / write the defaults to it. |

Field arguments accept commas or spaces (`hide ttft cache`). A name that is not a field is named back to you instead
of being silently dropped. Hiding every field disables line rendering entirely.

## Measurement notes

- Anchors: `before_agent_start` (prompt submitted and expanded) → `agent_settled` (Pi will not continue on its own).
  `agent_start` is the fallback anchor for runs not started by a prompt, so extension-triggered runs are still measured.
- TTFT is response-level (user-perceived), not per-request: it stops at the first token of the first request, so it
  includes provider queueing and prompt prefill. Requests after the first are not timed separately.
- Durations use a monotonic clock (`performance.now()`); wall-clock jumps cannot corrupt them.
- `cache` is per response, so it rises across a session as the prompt prefix gets cached, unlike pi's session-level
  cache figure.
- Cost is the sum of what pi reports per request. `usage.cost.totalFromProvider` decides the marker: every request
  billed → `$0.0043`, any catalog estimate → `~$0.0043`. The field is dropped when there is no pricing data and when
  the total is (or rounds to) zero, so unpriced and free models show nothing instead of a misleading `$0`.
- Nested tool usage (subagents, classifier calls) keeps its own cost in the expanded line. It enters `cost` only when
  `includeNestedUsage` is on.
- A settle with no assistant request produces no entry, so idle `agent_settled` noise stays out of the transcript.
- Not attributed: compaction and branch-summary token spend (they are not assistant messages), and nested agent spend
  unless `includeNestedUsage` is on and the tool reports that usage in its `tool_result` `usage` field. That is pi's
  documented accounting channel, so a tool that reports child usage elsewhere is invisible to pi's own totals too.

## Development

```bash
npm run typecheck                 # tsc --noEmit against the installed pi types
npm test                          # formatter tests + extension tests over a fake pi API, node >= 23.6
python3 test/rpc-smoke.py         # drives a real pi process over RPC mode (exit 2 = skipped: no auth, or the provider rate-limited the run)
```

`test/rpc-smoke.py` needs a writable `PI_CODING_AGENT_DIR`; point it at a scratch dir with `auth.json` linked in so a
test run cannot touch your real config or session list.

## Layout

```
extensions/prompt-status.ts   the extension: events, aggregation, entry renderer, command
src/format.ts                 pure formatters (duration, counts, rates, percentages, line assembly)
test/format.test.mjs          formatter assertions
test/extension.test.mjs       the real extension driven by a fake ExtensionAPI: windows,
                              aggregation, renderer, every command verb, config
test/rpc-smoke.py             end-to-end harness over pi's RPC mode
```

## License

MIT — see [LICENSE](LICENSE).
