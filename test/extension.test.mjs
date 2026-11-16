// Extension-level tests: drive the real handlers, renderer, and commands through a
// fake ExtensionAPI. No provider, no network, no pi process.
//
//   node --test test/
//
// Run under a scratch PI_CODING_AGENT_DIR so nothing touches the real config file.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { default: promptStatus } = await import("../extensions/prompt-status.ts");

function scratchDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-status-test-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	return dir;
}

function usage(over = {}) {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: { total: 0, totalFromProvider: true },
		...over,
	};
}

/** One fake pi: records handlers, commands, renderers, entries, notifications, footer writes. */
function harness({ entries = [], hasUI = true, configText } = {}) {
	const dir = scratchDir();
	if (configText !== undefined) fs.writeFileSync(path.join(dir, "prompt-status.json"), configText, "utf8");

	const handlers = new Map();
	const commands = new Map();
	const renderers = new Map();
	const appended = [];
	const notices = [];
	const footer = [];

	const pi = {
		on(name, fn) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerCommand(name, def) {
			commands.set(name, def);
		},
		registerEntryRenderer(type, fn) {
			renderers.set(type, fn);
		},
		appendEntry(type, data) {
			appended.push(data);
			entries.push({ type: "custom", customType: type, data });
		},
	};
	promptStatus(pi);

	const ctx = {
		hasUI,
		ui: {
			notify: (message, kind) => notices.push({ message, kind }),
			setStatus: (key, value) => footer.push({ key, value }),
		},
		sessionManager: { getEntries: () => entries },
	};

	const emit = async (name, event = {}) => {
		for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
	};
	const run = async (args = "") => {
		await commands.get("prompt-status").handler(args, ctx);
	};
	/** Every string the renderer asked the theme to color, in draw order. */
	const render = (data, expanded = false) => {
		const seen = [];
		const theme = { fg: (_kind, text) => { seen.push(String(text)); return String(text); } };
		const component = renderers.get("prompt-status")({ type: "custom", customType: "prompt-status", data }, { expanded }, theme);
		return { component, seen };
	};
	const config = () => JSON.parse(fs.readFileSync(path.join(dir, "prompt-status.json"), "utf8"));
	const lastNotice = () => notices[notices.length - 1]?.message ?? "";

	return { dir, entries, emit, run, render, config, lastNotice, notices, appended, footer, hasUI: () => ctx.hasUI };
}

/** Event payloads shaped like pi 1.5.2's real ones (see core/extensions/types.d.ts). */
const delta = () => ({
	type: "message_update",
	message: { role: "assistant" },
	assistantMessageEvent: { type: "text_delta" },
});
const end = (u, model = "test-model") => ({
	type: "message_end",
	message: { role: "assistant", model, usage: u },
});

/** A settled two-request response with one tool call in the middle. */
async function respond(h, { second = {}, nested = null, aborted = false } = {}) {
	await h.emit("before_agent_start", { type: "before_agent_start" });
	await h.emit("message_update", delta());
	await h.emit("message_end", end(usage({ input: 1000, output: 20, cacheRead: 3000 })));
	if (nested) {
		await h.emit("tool_result", { type: "tool_result", toolCallId: "c1", toolName: "subagent", input: {}, content: [], isError: false, usage: nested });
	}
	await h.emit("message_update", delta());
	await h.emit("message_end", end(usage({ input: 1200, output: 30, cacheRead: 4000, ...second })));
	await h.emit("agent_settled", { type: "agent_settled", aborted });
	return h.appended[h.appended.length - 1];
}

test("aggregates every request in one response", async () => {
	const h = harness();
	const data = await respond(h);
	assert.equal(data.requests, 2, "both assistant messages count as one response");
	assert.equal(data.sent, 1000 + 3000 + 1200 + 4000, "sent totals all prompt tokens across requests");
	assert.equal(data.recv, 50);
	assert.equal(Math.round(data.cacheHitPct), 76, "cacheRead / all prompt tokens: 7000 / 9200");
	assert.deepEqual(data.models, ["test-model"]);
	assert.equal(data.aborted, false);
	assert.equal(data.tpsMode, "response", "the mode used is recorded for the detail line");
});

test("steered continuation stays in one response", async () => {
	const h = harness();
	await h.emit("before_agent_start", {});
	await h.emit("message_end", end(usage({ input: 10, output: 5 }), "m"));
	await h.emit("agent_start", { type: "agent_start" }); // a queued continuation does not open a second window
	await h.emit("message_end", end(usage({ input: 20, output: 5 }), "m"));
	await h.emit("agent_settled", { type: "agent_settled", aborted: false });
	assert.equal(h.appended.length, 1, "one status line per settle boundary");
	assert.equal(h.appended[0].requests, 2);
});

test("generation mode divides by the decode window whenever it is nonzero", async () => {
	const h = harness({ configText: JSON.stringify({ tpsMode: "generation" }) });
	const data = await respond(h);
	assert.ok(data.generationMs > 0, "the response recorded a streaming window");
	const expected = (data.recv / data.generationMs) * 1000;
	assert.ok(Math.abs(data.tps - expected) / expected < 0.05, `tps ${data.tps} should track the decode window, not wall duration`);
});

test("nested usage adds to sent/recv only when enabled", async () => {
	const nested = usage({ input: 500, output: 40, cacheRead: 100 });
	const off = await respond(harness(), { nested });
	assert.equal(off.sent, 9200, "nested usage is excluded by default");
	assert.equal(off.nestedSent, 600, "but still recorded for the expanded line");

	const on = await respond(harness({ configText: JSON.stringify({ includeNestedUsage: true }) }), { nested });
	assert.equal(on.sent, 9200 + 600);
	assert.equal(on.recv, 50 + 40);
});

test("nested cache tokens follow sentIncludesCache", async () => {
	const nested = usage({ input: 500, output: 40, cacheRead: 100 });
	const data = await respond(
		harness({ configText: JSON.stringify({ includeNestedUsage: true, sentIncludesCache: false }) }),
		{ nested },
	);
	assert.equal(data.sent, 1000 + 1200 + 500, "only uncached prompt tokens, main and nested");
});

test("cost is provider-billed only when every counted request was billed", async () => {
	const plain = await respond(harness());
	assert.equal(plain.cost, 0);
	assert.equal(plain.costBilled, true, "all requests reported provider totals");

	const estimated = await respond(harness(), { second: { cost: { total: 0.01, totalFromProvider: false } } });
	assert.equal(estimated.cost, 0.01);
	assert.equal(estimated.costBilled, false, "one catalog estimate makes the sum an estimate");

	// Billed main requests + an estimated nested request must not be labeled as billed.
	const mixed = await respond(harness({ configText: JSON.stringify({ includeNestedUsage: true }) }), {
		nested: usage({ input: 10, output: 5, cost: { total: 0.02, totalFromProvider: false } }),
	});
	assert.equal(mixed.cost, 0.02);
	assert.equal(mixed.costBilled, false, "a total that includes an estimate is not provider-billed");
	assert.equal(mixed.nestedCostBilled, false);
});

test("unpriced models report no cost at all", async () => {
	const h = harness();
	await h.emit("before_agent_start", { type: "before_agent_start" });
	await h.emit("message_end", end({ input: 5, output: 5 }, "m"));
	await h.emit("agent_settled", { type: "agent_settled", aborted: false });
	const data = h.appended[0];
	assert.equal(data.cost, null, "no cost object means no cost figure");
	assert.equal(data.costBilled, null);
	const { seen } = h.render(data);
	assert.equal(seen.some((token) => token.includes("$")), false, "cost renders nothing when unpriced");
});

test("abort is recorded, and can be hidden by config", async () => {
	const aborted = await respond(harness(), { aborted: true });
	assert.equal(aborted.aborted, true);
	const h = harness({ configText: JSON.stringify({ showAborted: false }) });
	await respond(h, { aborted: true });
	assert.equal(h.appended.length, 0, "showAborted off writes nothing");
});

test("a settle with no request writes nothing", async () => {
	const h = harness();
	await h.emit("agent_settled", { type: "agent_settled", aborted: false });
	await h.emit("before_agent_start", { type: "before_agent_start" });
	await h.emit("agent_settled", { type: "agent_settled", aborted: false });
	assert.equal(h.appended.length, 0);
});

test("footer mirror is cleared when the footer is turned off", async () => {
	const h = harness();
	await h.run("footer on");
	await respond(h);
	assert.ok(h.footer.at(-1).value, "the status was mirrored");
	await h.run("footer off");
	assert.equal(h.footer.at(-1).value, undefined, "turning it off clears the stale line");
});

test("order and visibility come from config, not the renderer", async () => {
	const h = harness();
	const data = await respond(h);
	await h.run("order tps,finished");
	const reordered = h.render(data);
	assert.ok(reordered.seen.indexOf("⚡") < reordered.seen.indexOf("◷"), "tokens/s draws before finish time");

	await h.run("hide ttft cache");
	const hidden = h.render(data);
	assert.equal(hidden.seen.includes("TTFT"), false);
	assert.equal(hidden.seen.includes("cache"), false);
	await h.run("show ttft");
	assert.equal(h.render(data).seen.includes("TTFT"), true, "re-showing restores the field in place");
});

test("unknown field names are reported by name", async () => {
	const h = harness();
	await h.run("order bogus,ttft");
	assert.match(h.lastNotice(), /bogus/, "the rejected token is named");
	await h.run("hide nope");
	assert.match(h.lastNotice(), /nope/);
});

test("last and stats survive a resume", async () => {
	const first = harness();
	const data = await respond(first);
	// Simulate reopening the same session: a fresh extension instance, entries already stored.
	const resumed = harness({ entries: [{ type: "custom", customType: "prompt-status", data }] });
	await resumed.run("last");
	assert.match(resumed.lastNotice(), /◷/, "last reads the durable entry, not process memory");
	await resumed.run("stats");
	assert.match(resumed.lastNotice(), /responses 1/);
});

test("the renderer tolerates a hand-edited entry", async () => {
	const h = harness();
	await respond(h);
	const partial = { v: 1, finishedAt: Date.now(), durationMs: 1000, generationMs: 10, ttftMs: 5, sent: 10, recv: 2 };
	const { component } = h.render(partial, true);
	assert.ok(component, "expanded rendering does not throw on a version-1 entry missing models");
});

test("config round-trips, and corrupt config falls back to defaults", async () => {
	const h = harness();
	await h.run("order finished,cost");
	await h.run("hide cost");
	const saved = h.config();
	assert.deepEqual(saved.fields, ["finished", "cost", "duration", "ttft", "tps", "sent", "recv", "cache"], "unlisted fields keep default order");
	assert.deepEqual(saved.hidden, ["cost"]);

	const broken = harness({ configText: "{ not json" });
	const data = await respond(broken);
	assert.equal(data.sent, 9200, "a corrupt config falls back to defaults instead of failing");
	assert.ok(broken.render(data).component, "the entry still renders");
});
