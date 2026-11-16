/**
 * Pure formatting helpers for the prompt-status extension.
 *
 * Keep this module free of pi imports and of non-erasable TypeScript syntax so
 * it can be imported directly by `node` (type stripping) in tests.
 */

export type TpsMode = "response" | "generation";

export type StatusField = "duration" | "finished" | "ttft" | "tps" | "sent" | "recv" | "cache" | "cost";

/** Render order out of the box: finish time, duration, TTFT, tokens/s, sent, recv, cache, cost. */
export const ALL_FIELDS: StatusField[] = ["finished", "duration", "ttft", "tps", "sent", "recv", "cache", "cost"];

export function isStatusField(value: unknown): value is StatusField {
	return typeof value === "string" && (ALL_FIELDS as string[]).includes(value);
}

/**
 * Normalize a requested order and visibility set.
 *
 * Recognized keys are applied first in the requested order; unknown keys are dropped.
 * Fields left out of `order` keep their relative default order and land at the end.
 * `hidden` removes a field from the rendered line without dropping it from `order`.
 */
export function resolveFields(order: readonly StatusField[], hidden: readonly StatusField[]): StatusField[] {
	const seen: StatusField[] = [];
	for (const field of order) if (isStatusField(field) && !seen.includes(field)) seen.push(field);
	for (const field of ALL_FIELDS) if (!seen.includes(field)) seen.push(field);
	return seen.filter((field) => !hidden.includes(field));
}

/** Status written to the session as a `prompt-status` custom entry. */
export interface PromptStatusData {
	v: 1;
	/** Wall-clock time the response finished, epoch ms. */
	finishedAt: number;
	/** Prompt submit -> fully settled, ms. */
	durationMs: number;
	/** Sum of streaming (decode) windows, ms. Excludes tool execution and gaps. */
	generationMs: number;
	/** Prompt submit -> first output token, ms. Null when no token arrived. */
	ttftMs: number | null;
	/** Prompt tokens the provider was sent: input + cache read + cache write (or input only). */
	sent: number;
	/** Output tokens received. */
	recv: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** cacheRead / sent, 0..100. Null when nothing was sent. */
	cacheHitPct: number | null;
	/** recv / measured seconds, per tpsMode. */
	tps: number;
	/** Provider requests that produced an assistant message. */
	requests: number;
	models: string[];
	aborted: boolean;
	nestedSent: number;
	nestedRecv: number;
	nestedCost: number;
	/** Sum of `usage.cost.total`, or null when no request reported cost data. */
	cost: number | null;
	/** True when every cost figure was billed by the provider; false when any part is a catalog estimate. */
	costBilled: boolean | null;
	tpsMode: TpsMode;
}

/** `20s`, `1m20s`, `1h20m`, `2d3h`, `840ms`. */
export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0s";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSec = ms / 1000;
	if (totalSec < 10) return `${trimZero(totalSec.toFixed(1))}s`;
	if (totalSec < 60) return `${Math.min(59, Math.round(totalSec))}s`;
	const totalMin = Math.floor(totalSec / 60);
	if (totalMin < 60) return `${totalMin}m${Math.floor(totalSec % 60)}s`;
	const hours = Math.floor(totalMin / 60);
	if (hours < 24) return `${hours}h${totalMin % 60}m`;
	return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** `0`, `0.0043`, `0.123`, `1.5`, `12.35`, `1.2k`. The currency sign comes from the field icon. */
export function fmtCost(total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "0";
	if (total >= 1000) return `${trimZero((total / 1000).toFixed(1))}k`;
	if (total >= 1) return trimZero(total.toFixed(2));
	if (total >= 0.1) return trimZero(total.toFixed(3));
	return trimZero(total.toFixed(4));
}

/** True when a cost is worth showing: priced, and big enough not to read as "$0". */
export function hasCost(total: number | null | undefined): boolean {
	return total !== null && total !== undefined && fmtCost(total) !== "0";
}

/** Time to first token: `840ms`, `1.2s`, `12s`, `1m20s`. */
export function fmtTtft(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms < 0) return "n/a";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 10000) return `${trimZero((ms / 1000).toFixed(2))}s`;
	if (ms < 60000) return `${Math.round(ms / 1000)}s`;
	return fmtDuration(ms);
}

/** `941`, `1.23k`, `12.3k`, `1.2M`. */
export function fmtCount(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${trimZero(k < 10 ? k.toFixed(2) : k.toFixed(1))}k`;
	}
	return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

/** `0.4`, `8.6`, `42`. */
export function fmtRate(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 10) return trimZero(n.toFixed(1));
	return `${Math.round(n)}`;
}

/** `14:33:05` in the machine's local 24-hour clock. */
export function fmtClock(epochMs: number): string {
	const d = new Date(epochMs);
	const p = (v: number) => String(v).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `87%`, `<1%`, `n/a`. Never rounds a partial hit up to 100%. */
export function fmtPct(pct: number | null): string {
	if (pct === null || !Number.isFinite(pct)) return "n/a";
	if (pct <= 0) return "0%";
	if (pct < 1) return "<1%";
	if (pct >= 100) return "100%";
	return `${Math.min(99, Math.round(pct))}%`;
}

export interface StatusPart {
	icon: string;
	label: string;
	value: string;
	/** Render the value directly after the icon, as in `$0.0043`. */
	glue?: boolean;
}

const ICONS: Record<StatusField, string> = {
	duration: "⏱",
	finished: "◷",
	ttft: "TTFT",
	tps: "⚡",
	sent: "↑",
	recv: "↓",
	cache: "cache",
	cost: "$",
};

/** Only tokens/s carries a word; the rest read from their icon. */
const LABELS: Record<StatusField, string> = {
	duration: "",
	finished: "",
	ttft: "",
	tps: "tok/s",
	sent: "",
	recv: "",
	cache: "",
	cost: "",
};

export function iconOf(field: StatusField): string {
	return ICONS[field];
}

export function statusParts(data: PromptStatusData, fields: StatusField[]): StatusPart[] {
	const parts: StatusPart[] = [];
	for (const field of fields) {
		const icon = ICONS[field];
		const label = LABELS[field];
		switch (field) {
			case "duration":
				parts.push({ icon, label, value: fmtDuration(data.durationMs) });
				break;
			case "finished":
				parts.push({ icon, label, value: fmtClock(data.finishedAt) });
				break;
			case "ttft":
				parts.push({ icon, label, value: fmtTtft(data.ttftMs) });
				break;
			case "tps":
				parts.push({ icon, label, value: fmtRate(data.tps) });
				break;
			case "sent":
				parts.push({ icon, label, value: fmtCount(data.sent) });
				break;
			case "recv":
				parts.push({ icon, label, value: fmtCount(data.recv) });
				break;
			case "cache":
				parts.push({ icon, label, value: fmtPct(data.cacheHitPct) });
				break;
			case "cost": {
				// No pricing data, or a total that rounds to zero: show nothing rather than "$0".
				if (!hasCost(data.cost)) break;
				parts.push({
					icon: data.costBilled === true ? "$" : "≈$",
					label,
					value: fmtCost(data.cost ?? 0),
					glue: true,
				});
				break;
			}
		}
	}
	return parts;
}

/** Single-line, plain-text status. Used for tests, `notify`, and footer status. */
export function statusLine(data: PromptStatusData, fields: StatusField[], separator = " · "): string {
	const text = statusParts(data, fields)
		.map((p) => {
			const head = `${p.icon}${p.glue ? "" : " "}${p.value}`;
			return p.label ? `${head} ${p.label}` : head;
		})
		.join(separator);
	return data.aborted ? `aborted${separator}${text}` : text;
}

/** Second line for the expanded transcript view. Empty string when nothing to add. */
export function statusDetail(data: PromptStatusData): string {
	const bits: string[] = [];
	bits.push(`req ${data.requests}`);
	if (data.generationMs > 0) {
		const genTps = data.generationMs > 0 ? (data.recv / data.generationMs) * 1000 : 0;
		bits.push(`gen ${fmtDuration(data.generationMs)}`, `gen-only ${fmtRate(genTps)} tok/s`);
	}
	if (data.input > 0) bits.push(`uncached ↑${fmtCount(data.input)}`);
	if (data.cacheWrite > 0) bits.push(`cache w ${fmtCount(data.cacheWrite)}`);
	if (data.nestedSent > 0 || data.nestedRecv > 0) {
		const nested = `nested ↑${fmtCount(data.nestedSent)} ↓${fmtCount(data.nestedRecv)}`;
		bits.push(data.nestedCost > 0 ? `${nested} ≈$${fmtCost(data.nestedCost)}` : nested);
	}
	if (data.models.length > 0) bits.push(data.models.join(", "));
	return bits.join(" · ");
}

function trimZero(s: string): string {
	if (!s.includes(".")) return s;
	return s.replace(/0+$/, "").replace(/\.$/, "");
}
