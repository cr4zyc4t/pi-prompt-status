/**
 * prompt-status — one status line per response in pi.
 *
 * A "response" spans from submitting the prompt until the agent fully settles,
 * so every provider request, tool call, retry, and queued continuation in
 * between is measured as one unit.
 *
 * Status fields: duration, finish time (HH:MM:SS), TTFT, tokens/s, sent tokens,
 * received tokens, cache hit rate.
 *
 * The status is written as a `prompt-status` custom session entry, so it stays
 * in the transcript, survives `/reload`, `/resume`, `/fork` and `/tree`, and
 * never enters LLM context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	ALL_FIELDS,
	fmtCount,
	fmtCost,
	fmtDuration,
	fmtRate,
	isStatusField,
	resolveFields,
	statusDetail,
	statusLine,
	statusParts,
	type PromptStatusData,
	type StatusField,
	type TpsMode,
} from "../src/format.ts";

const ENTRY_TYPE = "prompt-status";
const STATUS_KEY = "prompt-status";
const CONFIG_BASENAME = "prompt-status.json";

interface Config {
	/** Write status entries at all. */
	enabled: boolean;
	/** Render order for all fields; fields left out land last. */
	fields: StatusField[];
	/** Fields kept out of the line. They stay in `fields`, so re-showing keeps their position. */
	hidden: StatusField[];
	/** "response": output tokens / whole response duration. "generation": decode windows only. */
	tpsMode: TpsMode;
	/** Count cache read/write in the "sent" figure. Cache hit % always uses all prompt tokens. */
	sentIncludesCache: boolean;
	/** Add usage reported by tools (subagents, nested LLM calls) to sent/recv. */
	includeNestedUsage: boolean;
	/** Still write a status when the run was aborted with Escape. */
	showAborted: boolean;
	/** Mirror the last status into pi's footer. */
	footerStatus: boolean;
	/** Also write entries in print/JSON mode, where there is no transcript. */
	nonInteractive: boolean;
}

const DEFAULTS: Config = {
	enabled: true,
	fields: [...ALL_FIELDS],
	hidden: [],
	tpsMode: "response",
	sentIncludesCache: true,
	includeNestedUsage: false,
	showAborted: true,
	footerStatus: false,
	nonInteractive: false,
};

interface Open {
	startMono: number;
	firstTokenMono: number | null;
	/** Accumulated streaming windows, ms. */
	generationMs: number;
	/** Start of the currently open streaming window, or null. */
	windowOpenMono: number | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	nestedInput: number;
	nestedOutput: number;
	nestedCacheRead: number;
	nestedCacheWrite: number;
	/** Sum of `usage.cost.total` over the main model's requests. */
	cost: number;
	/** True once any request carried a `cost` object, i.e. the model has pricing data. */
	costSeen: boolean;
	/** True when a request's total was a catalog estimate rather than provider-billed. */
	costEstimated: boolean;
	nestedCost: number;
	requests: number;
	models: string[];
}

function newOpen(): Open {
	return {
		startMono: performance.now(),
		firstTokenMono: null,
		generationMs: 0,
		windowOpenMono: null,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		nestedInput: 0,
		nestedOutput: 0,
		nestedCacheRead: 0,
		nestedCacheWrite: 0,
		cost: 0,
		costSeen: false,
		costEstimated: false,
		nestedCost: 0,
		requests: 0,
		models: [],
	};
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function configPath(): string {
	return path.join(agentDir(), CONFIG_BASENAME);
}

function readBool(source: Record<string, unknown>, key: keyof Config, fallback: boolean): boolean {
	const value = source[key];
	return typeof value === "boolean" ? value : fallback;
}

function readFieldList(value: unknown, fallback: StatusField[]): StatusField[] {
	if (!Array.isArray(value)) return [...fallback];
	const seen: StatusField[] = [];
	for (const item of value) {
		if (isStatusField(item) && !seen.includes(item)) seen.push(item);
	}
	return seen;
}

/** Read `a,b,c` / `a b` style field arguments, collecting anything unrecognized. */
function parseFieldArgs(words: string[]): { fields: StatusField[]; bad: string[] } {
	const fields: StatusField[] = [];
	const bad: string[] = [];
	for (const word of words) {
		for (const token of word.split(",").map((part) => part.trim()).filter(Boolean)) {
			const key = token.toLowerCase();
			if (isStatusField(key)) {
				if (!fields.includes(key)) fields.push(key);
			} else {
				bad.push(token);
			}
		}
	}
	return { fields, bad };
}

function parseConfig(raw: string): Config {
	const parsed: unknown = JSON.parse(raw);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("expected a JSON object");
	}
	const source = parsed as Record<string, unknown>;
	const mode = source.tpsMode;
	return {
		enabled: readBool(source, "enabled", DEFAULTS.enabled),
		fields: readFieldList(source.fields, DEFAULTS.fields),
		hidden: readFieldList(source.hidden, []),
		tpsMode: mode === "generation" || mode === "response" ? mode : DEFAULTS.tpsMode,
		sentIncludesCache: readBool(source, "sentIncludesCache", DEFAULTS.sentIncludesCache),
		includeNestedUsage: readBool(source, "includeNestedUsage", DEFAULTS.includeNestedUsage),
		showAborted: readBool(source, "showAborted", DEFAULTS.showAborted),
		footerStatus: readBool(source, "footerStatus", DEFAULTS.footerStatus),
		nonInteractive: readBool(source, "nonInteractive", DEFAULTS.nonInteractive),
	};
}

export default function (pi: ExtensionAPI) {
	let config: Config = { ...DEFAULTS };
	let configError: string | null = null;
	let open: Open | null = null;
	let lastData: PromptStatusData | null = null;

	function loadConfig(): void {
		try {
			const file = configPath();
			config = fs.existsSync(file) ? parseConfig(fs.readFileSync(file, "utf8")) : { ...DEFAULTS };
			configError = null;
		} catch (error) {
			configError = error instanceof Error ? error.message : String(error);
		}
	}

	function saveConfig(ctx?: Pick<ExtensionContext, "ui">): void {
		try {
			const file = configPath();
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx?.ui.notify(`prompt-status: could not save ${configPath()}: ${message}`, "error");
		}
	}

	loadConfig();

	function visible(): StatusField[] {
		return resolveFields(config.fields, config.hidden);
	}

	function closeGenerationWindow(state: Open): void {
		if (state.windowOpenMono === null) return;
		state.generationMs += performance.now() - state.windowOpenMono;
		state.windowOpenMono = null;
	}

	function finalize(aborted: boolean, ctx: ExtensionContext): void {
		const state = open;
		open = null;
		if (config.footerStatus && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		if (!state) return;
		const shown = visible();
		if (!config.enabled || shown.length === 0) return;
		if (!ctx.hasUI && !config.nonInteractive) return;
		if (aborted && !config.showAborted) return;
		// A settle with no assistant request produced nothing to report.
		if (state.requests === 0 && state.output === 0) return;

		const durationMs = Math.max(0, performance.now() - state.startMono);
		closeGenerationWindow(state);

		const promptTotal = state.input + state.cacheRead + state.cacheWrite;
		const nestedSent = state.nestedInput + state.nestedCacheRead + state.nestedCacheWrite;
		const sent =
			(config.sentIncludesCache ? promptTotal : state.input) +
			(config.includeNestedUsage ? nestedSent : 0);
		const recv = state.output + (config.includeNestedUsage ? state.nestedOutput : 0);
		const measuredMs = config.tpsMode === "generation" && state.generationMs > 250 ? state.generationMs : durationMs;
		const data: PromptStatusData = {
			v: 1,
			finishedAt: Date.now(),
			durationMs,
			generationMs: state.generationMs,
			ttftMs: state.firstTokenMono === null ? null : Math.max(0, state.firstTokenMono - state.startMono),
			sent,
			recv,
			input: state.input,
			cacheRead: state.cacheRead,
			cacheWrite: state.cacheWrite,
			cacheHitPct: promptTotal > 0 ? (state.cacheRead / promptTotal) * 100 : null,
			tps: measuredMs > 0 ? (recv / measuredMs) * 1000 : 0,
			requests: state.requests,
			models: state.models,
			aborted,
			nestedSent,
			nestedRecv: state.nestedOutput,
			nestedCost: state.nestedCost,
			cost: state.costSeen ? state.cost + (config.includeNestedUsage ? state.nestedCost : 0) : null,
			costBilled: state.costSeen ? !state.costEstimated : null,
			tpsMode: config.tpsMode,
		};

		lastData = data;
		pi.appendEntry<PromptStatusData>(ENTRY_TYPE, data);
		if (config.footerStatus && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, statusLine(data, shown, " "));
	}

	pi.on("session_start", async (_event, ctx) => {
		loadConfig();
		open = null;
		if (configError && ctx.hasUI) {
			ctx.ui.notify(`prompt-status: invalid ${configPath()} (${configError})`, "warning");
		}
	});

	// Prompt submitted and expanded: the earliest anchor for a response.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!open) open = newOpen();
		if (config.footerStatus && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// Fallback anchor for runs that did not start from a prompt.
	pi.on("agent_start", async () => {
		open ??= newOpen();
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		const kind = event.assistantMessageEvent.type;
		if (kind !== "text_delta" && kind !== "thinking_delta" && kind !== "toolcall_delta") return;
		open ??= newOpen();
		const state = open;
		const now = performance.now();
		if (state.firstTokenMono === null) state.firstTokenMono = now;
		if (state.windowOpenMono === null) state.windowOpenMono = now;
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant" || !open) return;
		const state = open;
		closeGenerationWindow(state);
		const usage = event.message.usage;
		if (usage) {
			state.input += usage.input || 0;
			state.output += usage.output || 0;
			state.cacheRead += usage.cacheRead || 0;
			state.cacheWrite += usage.cacheWrite || 0;
			const cost = usage.cost;
			if (cost) {
				state.costSeen = true;
				state.cost += cost.total || 0;
				if (cost.totalFromProvider !== true) state.costEstimated = true;
			}
		}
		state.requests += 1;
		const model = event.message.responseModel || event.message.model;
		if (model && !state.models.includes(model)) state.models.push(model);
	});

	// Usage that tools report for nested model work (subagents, classifier calls).
	pi.on("tool_result", async (event) => {
		const usage = event.usage;
		if (!usage || !open) return;
		open.nestedInput += usage.input || 0;
		open.nestedOutput += usage.output || 0;
		open.nestedCacheRead += usage.cacheRead || 0;
		open.nestedCacheWrite += usage.cacheWrite || 0;
		if (usage.cost) open.nestedCost += usage.cost.total || 0;
	});

	// Final and notification-only: no retry, compaction, or queued continuation is left.
	pi.on("agent_settled", async (event, ctx) => {
		finalize(event.aborted, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		open = null;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerEntryRenderer<PromptStatusData>(ENTRY_TYPE, (entry, options, theme) => {
		const data = entry.data;
		if (!data || data.v !== 1) return undefined;
		const parts = statusParts(data, visible());
		if (parts.length === 0) return undefined;
		const dot = theme.fg("dim", " · ");
		const line = parts
			.map((part) => {
				const value = theme.fg("muted", part.value);
				return `${theme.fg("dim", part.icon)}${part.glue ? "" : " "}${value}${part.label ? ` ${theme.fg("dim", part.label)}` : ""}`;
			})
			.join(dot);
		const head = data.aborted ? `${theme.fg("warning", "aborted")}${dot}${line}` : line;
		const detail = options.expanded ? statusDetail(data) : "";
		return new Text(detail ? `${head}\n${theme.fg("dim", detail)}` : head, 0, 0);
	});

	pi.registerCommand("prompt-status", {
		description: "Per-response status: show settings, toggle fields, or summarize the session",
		getArgumentCompletions: (prefix) => {
			const words = [
				"on",
				"off",
				"status",
				"last",
				"stats",
				"mode",
				"order",
				"fields",
				"show",
				"hide",
				"footer",
				"nested",
				"cache",
				"aborted",
				"path",
				"reset",
			];
			return words.filter((w) => w.startsWith(prefix.toLowerCase())).map((name) => ({ value: name, label: name }));
		},
		handler: async (args, ctx) => {
			const [verb = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const toggle = (key: "enabled" | "showAborted" | "footerStatus" | "includeNestedUsage" | "sentIncludesCache") => {
				const value = rest[0];
				config[key] = value === "on" ? true : value === "off" ? false : !config[key];
				saveConfig(ctx);
				ctx.ui.notify(`prompt-status: ${key} = ${config[key] ? "on" : "off"}`, "info");
			};
			switch (verb) {
				case "on":
				case "off":
					config.enabled = verb === "on";
					saveConfig(ctx);
					ctx.ui.notify(`prompt-status: ${config.enabled ? "enabled" : "disabled"}`, "info");
					return;
				case "mode": {
					const mode = rest[0];
					if (mode !== "response" && mode !== "generation") {
						ctx.ui.notify("prompt-status: mode is 'response' or 'generation'", "error");
						return;
					}
					config.tpsMode = mode;
					saveConfig(ctx);
					ctx.ui.notify(`prompt-status: tokens/s = ${mode === "generation" ? "output tokens / streaming time" : "output tokens / response duration"}`, "info");
					return;
				}
				case "order": {
					const { fields, bad } = parseFieldArgs(rest);
					if (fields.length === 0) {
						ctx.ui.notify(`prompt-status: order takes fields from ${ALL_FIELDS.join(", ")}`, "error");
						return;
					}
					config.fields = resolveFields(fields, []);
					saveConfig(ctx);
					ctx.ui.notify(
						`prompt-status: order = ${config.fields.join(", ")}${bad.length ? ` (ignored: ${bad.join(", ")})` : ""}`,
						"info",
					);
					return;
				}
				case "fields": {
					const { fields, bad } = parseFieldArgs(rest);
					if (fields.length === 0) {
						ctx.ui.notify(`prompt-status: fields takes a list from ${ALL_FIELDS.join(", ")}`, "error");
						return;
					}
					// Render exactly these, in this order; everything else is hidden.
					config.fields = resolveFields(fields, []);
					config.hidden = ALL_FIELDS.filter((field) => !fields.includes(field));
					saveConfig(ctx);
					ctx.ui.notify(
						`prompt-status: showing ${fields.join(", ")}${config.hidden.length ? ` · hidden ${config.hidden.join(", ")}` : ""}${bad.length ? ` (ignored: ${bad.join(", ")})` : ""}`,
						"info",
					);
					return;
				}
				case "show":
				case "hide": {
					const { fields, bad } = parseFieldArgs(rest);
					if (fields.length === 0) {
						ctx.ui.notify(`prompt-status: ${verb} takes fields from ${ALL_FIELDS.join(", ")}`, "error");
						return;
					}
					config.fields = resolveFields(config.fields, []);
					const hiddenSet = new Set(config.hidden);
					if (verb === "hide") for (const field of fields) hiddenSet.add(field);
					else for (const field of fields) hiddenSet.delete(field);
					config.hidden = ALL_FIELDS.filter((field) => hiddenSet.has(field));
					saveConfig(ctx);
					ctx.ui.notify(
						`prompt-status: ${verb === "hide" ? "hidden" : "shown"} ${fields.join(", ")} · line = ${visible().join(", ")}${bad.length ? ` (ignored: ${bad.join(", ")})` : ""}`,
						"info",
					);
					return;
				}
				case "footer":
					toggle("footerStatus");
					return;
				case "nested":
					toggle("includeNestedUsage");
					return;
				case "cache":
					toggle("sentIncludesCache");
					return;
				case "aborted":
					toggle("showAborted");
					return;
				case "path":
					ctx.ui.notify(configPath(), "info");
					return;
				case "reset":
					config = { ...DEFAULTS };
					saveConfig(ctx);
					ctx.ui.notify(`prompt-status: reset to defaults`, "info");
					return;
				case "last":
					ctx.ui.notify(lastData ? statusLine(lastData, visible(), " ") : "prompt-status: no response recorded yet", "info");
					return;
				case "stats": {
					const rows: PromptStatusData[] = [];
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
						const data = entry.data as PromptStatusData | undefined;
						if (data && data.v === 1) rows.push(data);
					}
					if (rows.length === 0) {
						ctx.ui.notify("prompt-status: no responses recorded in this session", "info");
						return;
					}
					const sum = (pick: (d: PromptStatusData) => number) => rows.reduce((total, d) => total + pick(d), 0);
					const wall = sum((d) => d.durationMs);
					const gen = sum((d) => d.generationMs);
					const recv = sum((d) => d.recv);
					const sent = sum((d) => d.sent);
					const cacheRead = sum((d) => d.cacheRead);
					const prompt = sum((d) => d.input + d.cacheRead + d.cacheWrite);
					const cost = sum((d) => d.cost ?? 0);
					const priced = rows.some((d) => typeof d.cost === "number");
					const billed = priced && rows.every((d) => d.costBilled === true);
					ctx.ui.notify(
						[
							`responses ${rows.length} · wall ${fmtDuration(wall)} · gen ${fmtDuration(gen)}`,
							`avg ${fmtRate((recv / Math.max(1, wall)) * 1000)} tok/s · cache ${prompt > 0 ? `${Math.round((cacheRead / prompt) * 100)}%` : "n/a"}`,
							`↑ ${fmtCount(sent)} · ↓ ${fmtCount(recv)}${priced ? ` · ${billed ? "$" : "≈$"}${fmtCost(cost)}` : ""}`,
						].join("\n"),
						"info",
					);
					return;
				}
				default:
					ctx.ui.notify(
						[
							`prompt-status ${config.enabled ? "on" : "off"} · tokens/s ${config.tpsMode} · footer ${config.footerStatus ? "on" : "off"}`,
							`order: ${resolveFields(config.fields, []).join(", ")}`,
							`hidden: ${config.hidden.length ? config.hidden.join(", ") : "(none)"}`,
							`sent ${config.sentIncludesCache ? "includes" : "excludes"} cache · nested ${config.includeNestedUsage ? "included" : "excluded"} · aborted ${config.showAborted ? "shown" : "hidden"}`,
							lastData ? `last: ${statusLine(lastData, visible(), " ")}` : "last: none yet",
							`/prompt-status on|off|order|fields|show|hide|mode|footer|nested|cache|aborted|last|stats|path|reset`,
						].join("\n"),
						"info",
					);
			}
		},
	});
}
