#!/usr/bin/env node
/**
 * Capture hooks for the turn loop.
 *
 *   capture.mjs user       UserPromptSubmit — queue the user's message + inject
 *   capture.mjs assistant  Stop — queue the assistant's reply, then flush
 *   capture.mjs tool       PostToolUse — queue a one-line tool summary
 *                          (only when capture.saveToolUse is on)
 *
 * Capture is inline and synchronous against a local file. Per-turn inject
 * follows Hermes/dsh: turn 1 may wait ~5s; later turns serve cache and refresh
 * in the background. Stop flush touches the network and exits 0 whatever
 * happens so the hook can never stall or fail a turn.
 */

import { loadConfig } from "./lib/config.mjs";
import { redactSecrets } from "./lib/redact.mjs";
import { isHarnessInjected, summarizeTool, lastAssistantText } from "./lib/capture-helpers.mjs";
import { appendMessage } from "./lib/state.mjs";
import { flushAll } from "./lib/flush.mjs";
import { handlePerTurnInject } from "./lib/inject.mjs";
import { readStdin, parseHookInput } from "./lib/io.mjs";

function captureReady(config) {
  return config.enabled && config.apiKey && config.capture.saveMessages;
}

/** The session id hooks are keyed on, from whatever shape the input takes. */
function sessionOf(input) {
  return input.session_id || input.sessionId || input.conversation_id || "unknown";
}

function cwdOf(input) {
  return input.cwd || input.project_dir || process.cwd();
}

// ── user ───────────────────────────────────────────────────────────────────

async function captureUser(config, input) {
  const prompt = input.prompt ?? input.user_prompt ?? input.userPrompt ?? "";
  const text = typeof prompt === "string" ? prompt : String(prompt);
  if (!text.trim() || isHarnessInjected(text)) return;

  const sessionId = sessionOf(input);

  if (captureReady(config)) {
    const cap = config.messageUpload.maxUserTokens * 4;
    appendMessage(sessionId, {
      role: "user",
      peerId: config.peerName,
      content: redactSecrets(text.slice(0, cap), config.capture.noisePatterns),
      cwd: cwdOf(input),
      session_id: sessionId,
      at: Date.now(),
    });
  }

  if (!config.enabled || !config.apiKey) return;

  const injected = await handlePerTurnInject(config, input, text);
  if (injected) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: injected } }),
    );
  }
}

// ── assistant ──────────────────────────────────────────────────────────────

async function captureAssistant(config, input) {
  const sessionId = sessionOf(input);
  const response =
    input.response ??
    input.last_response ??
    input.assistant_response ??
    (input.transcript_path ? lastAssistantText(input.transcript_path) : "") ??
    "";
  const text = typeof response === "string" ? response : String(response);

  if (captureReady(config) && text.trim()) {
    const cap = config.messageUpload.maxAssistantTokens * 4;
    appendMessage(sessionId, {
      role: "assistant",
      peerId: config.aiPeer,
      content: redactSecrets(text.slice(0, cap), config.capture.noisePatterns),
      cwd: cwdOf(input),
      session_id: sessionId,
      at: Date.now(),
    });
  }

  // Flushing also runs here when capture is off — a queue left over from a
  // session where it was on should still drain.
  const result = await flushAll({ config, timeoutMs: 25_000 });
  if (result.failed > 0) {
    process.stderr.write(`[zcode-honcho] flush: ${result.failed} message(s) deferred — ${result.error}\n`);
  }
}

// ── tool ───────────────────────────────────────────────────────────────────

async function captureTool(config, input) {
  if (!config.enabled || !config.apiKey || !config.capture.saveToolUse || !config.capture.saveMessages) return;
  const name = input.tool_name ?? input.toolName ?? "";
  const args = input.tool_input ?? input.toolInput ?? {};
  const summary = summarizeTool(name, args && typeof args === "object" ? args : {});
  if (!summary) return;

  const sessionId = sessionOf(input);
  const cap = config.messageUpload.maxAssistantTokens * 4;
  appendMessage(sessionId, {
    role: "assistant",
    peerId: config.aiPeer,
    content: redactSecrets(`[tool] ${summary}`.slice(0, cap), config.capture.noisePatterns),
    cwd: cwdOf(input),
    session_id: sessionId,
    at: Date.now(),
  });
}

// ── entrypoint ─────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2];
  const config = loadConfig();
  const input = parseHookInput(await readStdin());

  if (mode === "user") {
    await captureUser(config, input);
  } else if (mode === "assistant") {
    await captureAssistant(config, input);
  } else if (mode === "tool") {
    await captureTool(config, input);
  }
}

main()
  .catch((error) => {
    process.stderr.write(`[zcode-honcho] capture: ${error instanceof Error ? error.message : String(error)}\n`);
  })
  .finally(() => process.exit(0));
