// Unit tests for the pure formatters. Run with: node test/format.test.mjs
// Node >= 23.6 strips the TypeScript types in src/format.ts natively.

import assert from "node:assert/strict";
import {
	ALL_FIELDS,
	fmtClock,
	fmtCount,
	fmtDuration,
	fmtPct,
	fmtRate,
	fmtTtft,
	statusDetail,
	statusLine,
	statusParts,
} from "../src/format.ts";

let failures = 0;
function eq(actual, expected, label) {
	const ok = actual === expected;
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` != ${JSON.stringify(expected)}`}`);
}

// duration: 20s / 1m20s / 1h20m / 2d3h
eq(fmtDuration(0), "0ms", "duration 0");
eq(fmtDuration(840), "840ms", "duration sub-second");
eq(fmtDuration(8300), "8.3s", "duration one decimal under 10s");
eq(fmtDuration(20400), "20s", "duration 20s");
eq(fmtDuration(59700), "59s", "duration clamps under a minute");
eq(fmtDuration(80000), "1m20s", "duration 1m20s");
eq(fmtDuration(4800000), "1h20m", "duration 1h20m");
eq(fmtDuration(((2 * 24 + 3) * 60 * 60 + 4 * 60 + 5) * 1000), "2d3h", "duration 2d3h");

// tokens/s
eq(fmtRate(0.44), "0.4", "rate one decimal");
eq(fmtRate(8.64), "8.6", "rate under ten");
eq(fmtRate(42.6), "43", "rate integer above ten");
eq(fmtRate(0), "0", "rate zero");

// token counts
eq(fmtCount(0), "0", "count zero");
eq(fmtCount(941), "941", "count under thousand");
eq(fmtCount(1234), "1.23k", "count thousands");
eq(fmtCount(12345), "12.3k", "count ten thousands");
eq(fmtCount(1234567), "1.2M", "count millions");

// time to first token
eq(fmtTtft(null), "n/a", "ttft missing");
eq(fmtTtft(840), "840ms", "ttft ms");
eq(fmtTtft(1234), "1.23s", "ttft under ten seconds");
eq(fmtTtft(12300), "12s", "ttft seconds");
eq(fmtTtft(75000), "1m15s", "ttft minutes");

// cache hit rate
eq(fmtPct(null), "n/a", "cache missing");
eq(fmtPct(0), "0%", "cache zero");
eq(fmtPct(0.4), "<1%", "cache under one");
eq(fmtPct(87.4), "87%", "cache rounded");
eq(fmtPct(99.6), "99%", "cache never rounds up to 100");
eq(fmtPct(100), "100%", "cache full hit");

// clock
eq(/^\d{2}:\d{2}:\d{2}$/.test(fmtClock(Date.now())), true, "clock HH:MM:SS");

// full status line
const data = {
	v: 1,
	finishedAt: new Date(2026, 10, 16, 14, 33, 5).getTime(),
	durationMs: 80000,
	generationMs: 24000,
	ttftMs: 830,
	sent: 12300,
	recv: 3400,
	input: 1500,
	cacheRead: 10800,
	cacheWrite: 0,
	cacheHitPct: (10800 / 12300) * 100,
	tps: 42.5,
	requests: 4,
	models: ["claude-haiku-5.5"],
	aborted: false,
	nestedSent: 0,
	nestedRecv: 0,
	tpsMode: "response",
};
eq(
	statusLine(data, ALL_FIELDS),
	"⏱ 1m20s · ◷ 14:33:05 · TTFT 830ms · ⚡ 43 tok/s · ↑ 12.3k sent · ↓ 3.4k recv · cache 88%",
	"status line",
);
eq(statusParts(data, ["tps", "sent"]).length, 2, "field subset");
eq(statusLine({ ...data, aborted: true }, ["tps"]), "aborted · ⚡ 43 tok/s", "aborted prefix");
eq(
	statusDetail(data),
	"req 4 · gen 24s · gen-only 142 tok/s · uncached ↑1.5k · claude-haiku-5.5",
	"detail line",
);
eq(statusDetail({ ...data, cacheWrite: 2100 }).includes("cache w 2.1k"), true, "detail cache write");
eq(statusDetail({ ...data, models: ["m1", "m2"] }).includes("m1, m2"), true, "detail lists models");
eq(statusDetail({ ...data, nestedSent: 1200, nestedRecv: 300 }).includes("nested ↑1.2k ↓300"), true, "detail nested");

if (failures > 0) {
	console.log(`\n${failures} failing assertion(s)`);
	process.exit(1);
}
console.log("\nall assertions passed");
