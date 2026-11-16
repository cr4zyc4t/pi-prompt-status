#!/usr/bin/env python3
"""End-to-end smoke test for pi-prompt-status, driven over pi's RPC mode.

Requires: a pi build on PATH, a scratch PI_CODING_AGENT_DIR whose auth.json points at a
working provider, and a model that does not cost anything.

    A=/tmp/pstatus-agent W=/tmp/pstatus-work MODEL=openrouter/...:free
    mkdir -p "$A" "$W"
    ln -s ~/.pi/agent/auth.json "$A/auth.json"
    printf '{}\n' > "$A/prompt-status.json"
    cd "$W" && PI_CODING_AGENT_DIR="$A" python3 test/rpc-smoke.py

Checks: a response aggregates every provider request it made, a later response shows a cache
hit, an aborted run still writes a status with aborted=true, and the command verbs work.
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(os.path.dirname(HERE), "extensions", "prompt-status.ts")
MODEL = os.environ.get("MODEL", "openrouter/nvidia/nemotron-3.5-lightning:free")

if not os.environ.get("PI_CODING_AGENT_DIR"):
    sys.exit("set PI_CODING_AGENT_DIR to a scratch agent dir (see docstring)")

proc = subprocess.Popen(
    ["pi", "-e", EXT, "--model", MODEL, "--thinking", "off", "--mode", "rpc"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
)

events: queue.Queue = queue.Queue()


def pump(pipe, tag):
    for line in pipe:
        events.put((tag, line.rstrip("\n")))


threading.Thread(target=pump, args=(proc.stdout, "out"), daemon=True).start()
threading.Thread(target=pump, args=(proc.stderr, "err"), daemon=True).start()

failures = 0
seen = {"tools": 0}


def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def wait_for(predicate, timeout, label):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            tag, line = events.get(timeout=1)
        except queue.Empty:
            continue
        if tag == "err":
            if line.strip():
                print(f"  [stderr] {line}")
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        match = predicate(event)
        if match:
            return match
    print(f"  FAIL timeout waiting for {label}")
    return None


def check(condition, label):
    global failures
    print(f"  {'ok  ' if condition else 'FAIL'} {label}")
    if not condition:
        failures += 1


def status_entry(event):
    if event.get("type") == "tool_execution_start":
        seen["tools"] += 1
        return None
    if event.get("type") != "entry_appended":
        return None
    entry = event.get("entry", {})
    return entry["data"] if entry.get("customType") == "prompt-status" else None


def notification(want=None):
    def predicate(event):
        if event.get("type") != "extension_ui_request" or event.get("method") != "notify":
            return None
        message = event.get("message", "")
        return None if want and want not in message else message

    return predicate


print(f"model: {MODEL}\n")

print("1. tool-using response aggregates every request it made")
send({"id": "p1", "type": "prompt", "message": "Run the bash command 'echo hello' and tell me what it printed."})
first = wait_for(status_entry, 240, "status entry")
if first:
    print(f"   {json.dumps(first)}")
# A model that skipped the tool call legitimately produces one request.
expected = 2 if seen["tools"] else 1
check(first["requests"] >= expected, f"requests >= {expected} (tool executions seen: {seen['tools']})")
check(first["sent"] > 0 and first["recv"] > 0, "sent and recv populated")
check(first["ttftMs"] is not None and first["ttftMs"] < first["durationMs"], "TTFT inside the response")
check(not first["aborted"], "not aborted")

print("\n2. a later response shows a cache hit")
send({"id": "p2", "type": "prompt", "message": "Now run 'echo world' and report both outputs."})
second = wait_for(status_entry, 240, "second status entry")
if second:
    print(f"   cache={round(second['cacheHitPct'] or 0)}% requests={second['requests']}")
check(second["cacheHitPct"] is not None and second["cacheHitPct"] > 0, "cache hit > 0")

print("\n3. aborted run still writes a status")
send({"id": "p3", "type": "prompt", "message": "Write a 600-word essay about prompt caching, step by step."})


def first_text_delta(event):
    if event.get("type") != "message_update":
        return None
    return True if event.get("assistantMessageEvent", {}).get("type") == "text_delta" else None


# Abort while the model is provably mid-stream, so timing cannot race the answer.
if wait_for(first_text_delta, 90, "first text delta"):
    send({"id": "a1", "type": "abort"})
else:
    send({"id": "a1", "type": "abort"})
aborted = wait_for(status_entry, 90, "aborted status entry")
if aborted:
    print(f"   aborted={aborted['aborted']} requests={aborted['requests']}")
check(aborted is not None and aborted["aborted"] is True, "aborted=true")

print("\n4. /prompt-status commands")
send({"id": "c1", "type": "prompt", "message": "/prompt-status stats"})
stats = wait_for(notification("responses"), 30, "stats output")
check(bool(stats), f"stats reported: {stats!r}")

send({"id": "c2", "type": "prompt", "message": "/prompt-status mode generation"})
check(bool(wait_for(notification("streaming time"), 30, "mode output")), "mode switch acknowledged")

send({"id": "c3", "type": "prompt", "message": "/prompt-status hide cache"})
check(bool(wait_for(notification("hidden cache"), 30, "hide output")), "hide acknowledged")

send({"id": "c4", "type": "prompt", "message": "/prompt-status order tps,finished"})
check(bool(wait_for(notification("order = tps, finished,"), 30, "order output")), "order change acknowledged")

send({"id": "c5", "type": "prompt", "message": "/prompt-status show cache"})
check(bool(wait_for(notification("shown cache"), 30, "show output")), "show acknowledged")

send({"id": "c6", "type": "prompt", "message": "/prompt-status hide nosuchfield"})
check(bool(wait_for(notification("fields from"), 30, "error output")), "unknown field name rejected")

print("\n5. rendering follows order and visibility")
send({"id": "c7", "type": "prompt", "message": "/prompt-status fields finished,duration"})
check(bool(wait_for(notification("showing finished, duration"), 30, "fields output")), "exact field set acknowledged")
send({"id": "c8", "type": "prompt", "message": "/prompt-status last"})
lean = wait_for(notification("◷"), 30, "last output")
check(bool(lean), f"last status printed: {lean!r}")
check(lean is not None and "TTFT" not in lean and "⚡" not in lean, "hidden fields are gone from the line")
check(lean is not None and 0 <= lean.find("◷") < lean.find("⏱"), "finished renders before duration")

send({"id": "c9", "type": "prompt", "message": "/prompt-status reset"})
check(bool(wait_for(notification("reset to defaults"), 30, "reset output")), "reset acknowledged")
send({"id": "c10", "type": "prompt", "message": "/prompt-status last"})
full = wait_for(notification("TTFT"), 30, "last output after reset")
check(full is not None and "TTFT" in full and 0 <= full.find("◷") < full.find("TTFT"), f"defaults restored, finished first: {full!r}")
entry_cost = (aborted or first or {}).get("cost")
priced = isinstance(entry_cost, (int, float)) and entry_cost > 0
check(("$" in (full or "")) == priced, f"cost shows only when priced and nonzero (entry cost={entry_cost!r})")

send({"id": "q", "type": "get_state"})
wait_for(lambda e: e.get("type") == "response" and e.get("command") == "get_state", 30, "state")

proc.stdin.close()
try:
    proc.wait(timeout=30)
except subprocess.TimeoutExpired:
    proc.kill()

print(f"\n{'FAILED: ' + str(failures) + ' check(s)' if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
