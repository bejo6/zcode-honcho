/**
 * End-to-end smoke test for zcode-honcho against a mock Honcho API.
 * Run: node tests/smoke.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN = new URL("../plugins/zcode-honcho/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const seen = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname.endsWith("/context")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          messages: [],
          summary: { content: "We chose AlloyDB over RDS last week." },
          peer_representation:
            "**Pattern** [high]: Prefers terse answers.\n\nSources:\n- s1\n\n**Pattern** [low]: Late-night worker.",
          peer_card: ["Likes terse answers", "Working on a memory plugin"],
        }),
      );
      return;
    }
    if (pathname.endsWith("/chat")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: "Tester prefers terse answers and is building a memory plugin." }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const dir = mkdtempSync(join(tmpdir(), "honcho-e2e-"));
writeFileSync(
  join(dir, "config.json"),
  JSON.stringify({
    peerName: "tester",
    auth: { apiKey: "hch_fake" },
    baseUrl: `http://127.0.0.1:${port}`,
    hosts: { zcode: { workspace: "zc-test" } },
  }),
);

function hook(script, input, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PLUGIN, script), ...args], {
      env: { ...process.env, HONCHO_CONFIG_DIR: dir, HONCHO_API_KEY: "" },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}

function parseOut(out) {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const results = [];
const check = (name, condition, detail) => {
  results.push([condition ? "PASS" : "FAIL", name, detail ?? ""]);
  if (!condition) process.exitCode = 1;
};

const sessionInput = { session_id: "s1", cwd: "/repo/demo" };

// 1. user capture + Hermes/dsh turn-1 inject (blocks briefly for context)
let r = await hook(
  "hooks/capture.mjs",
  {
    ...sessionInput,
    prompt: "use token ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234 for the API",
  },
  ["user"],
);
let parsed = parseOut(r.out);
check("capture user exits 0", r.code === 0, r.out.slice(0, 200));
check(
  "turn 1 injects UserPromptSubmit additionalContext",
  parsed?.hookSpecificOutput?.hookEventName === "UserPromptSubmit" &&
    typeof parsed.hookSpecificOutput.additionalContext === "string" &&
    parsed.hookSpecificOutput.additionalContext.includes("<honcho-memory"),
  r.out.slice(0, 200),
);
check(
  "turn 1 includes peer card / high-confidence pattern",
  parsed?.hookSpecificOutput?.additionalContext.includes("Likes terse answers") &&
    parsed?.hookSpecificOutput?.additionalContext.includes("Prefers terse"),
  r.out.slice(0, 200),
);
check(
  "low-confidence patterns and provenance filtered out",
  parsed &&
    !parsed.hookSpecificOutput.additionalContext.includes("Late-night") &&
    !parsed.hookSpecificOutput.additionalContext.includes("Sources:"),
);
check(
  "turn 1 dialectic included when due",
  parsed?.hookSpecificOutput?.additionalContext.includes("building a memory plugin"),
  r.out.slice(0, 200),
);
const contextCallsAfterTurn1 = seen.filter((s) => s.url.includes("/context")).length;

// 2. harness-injected prompt skipped (no capture, no inject output)
r = await hook(
  "hooks/capture.mjs",
  { ...sessionInput, prompt: "<system-reminder>noise</system-reminder>" },
  ["user"],
);
check("harness prompt skipped silently", r.code === 0 && r.out === "", r.out);

// 3. turn 2 serves cache (no new blocking context fetch on the hot path)
r = await hook("hooks/capture.mjs", { ...sessionInput, prompt: "what did we decide?" }, ["user"]);
parsed = parseOut(r.out);
check("turn 2 injects from cache", parsed?.hookSpecificOutput?.additionalContext?.includes("<honcho-memory"), r.out.slice(0, 200));
check(
  "turn 2 did not block on a new context fetch",
  seen.filter((s) => s.url.includes("/context")).length === contextCallsAfterTurn1,
  `context calls: ${seen.filter((s) => s.url.includes("/context")).length}`,
);

// 4. assistant capture + flush to mock server
const transcript = join(dir, "t.jsonl");
writeFileSync(
  transcript,
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "All done." }] } }) + "\n",
);
r = await hook("hooks/capture.mjs", { ...sessionInput, transcript_path: transcript }, ["assistant"]);
check("assistant+flush exits 0", r.code === 0, r.out);
check("queue drained after successful flush", !existsSync(join(dir, "zcode", "queue", "s1.jsonl")));

const calls = (fragment) => seen.filter((s) => s.url.includes(fragment));
check("workspace get-or-create", calls("/workspaces").some((s) => s.method === "POST" && s.body?.id === "zc-test"));
const peerIds = new Set(calls("/peers").filter((s) => s.body?.id).map((s) => s.body.id));
check("peer get-or-create (both)", peerIds.has("tester") && peerIds.has("zcode"), [...peerIds].join(","));
check("session peers associated", calls("/sessions/tester-demo/peers").length >= 1);
const msgs = calls("/messages").flatMap((s) => s.body?.messages ?? []);
check(
  "3 messages uploaded (2 user turns + assistant; harness skipped)",
  msgs.length === 3,
  JSON.stringify(msgs),
);
check("secrets redacted in upload", msgs.some((m) => m.content.includes("***") && !m.content.includes("ghp_")));
check(
  "roles mapped to peers",
  msgs.filter((m) => m.peer_id === "tester").length === 2 && msgs.filter((m) => m.peer_id === "zcode").length === 1,
);

// 5. session-start: directives + warm cache (primary inject is per-turn)
r = await hook("hooks/session-start.mjs", { ...sessionInput, source: "startup" });
check("session-start exits 0", r.code === 0, r.out);
parsed = parseOut(r.out);
check(
  "session-start emits directives bootstrap",
  parsed?.hookSpecificOutput?.hookEventName === "SessionStart" &&
    typeof parsed.hookSpecificOutput.additionalContext === "string" &&
    parsed.hookSpecificOutput.additionalContext.includes("Honcho memory is available"),
  r.out.slice(0, 200),
);

// 6. session-start with no API key → silence
rmSync(join(dir, "config.json"));
r = await hook("hooks/session-start.mjs", { ...sessionInput, source: "startup" });
check("session-start without key: silent exit 0", r.code === 0 && r.out === "", r.out);

// Give detached bg workers a moment, then clean up.
await new Promise((resolve) => setTimeout(resolve, 300));

server.close();
for (const [status, name, detail] of results) console.log(`${status}  ${name}${detail ? `  — ${detail}` : ""}`);
console.log(`${results.filter((row) => row[0] === "PASS").length}/${results.length} passed`);
rmSync(dir, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
