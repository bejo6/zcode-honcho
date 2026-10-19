#!/usr/bin/env node
/**
 * SessionStart hook — Hermes/dsh/cursor aligned.
 *
 * Bootstraps peers, optionally emits static directives, and warms the
 * per-turn memory cache in the background. The reliable inject path is
 * UserPromptSubmit (handlePerTurnInject), not a full blocking fetch here.
 */

import { loadConfig } from "./lib/config.mjs";
import { handleSessionStart } from "./lib/inject.mjs";
import { readStdin, parseHookInput } from "./lib/io.mjs";
import { writeStatus, readStatus } from "./lib/state.mjs";

function emit(context) {
  process.stdout.write(JSON.stringify(context));
}

async function main() {
  const input = parseHookInput(await readStdin());
  const config = loadConfig();
  if (!config.enabled || !config.apiKey) return;

  const additionalContext = await handleSessionStart(config, input);
  writeStatus({
    lastSession: input.session_id || input.sessionId || input.conversation_id,
    lastFetchAt: Date.now(),
    lastFetchError: undefined,
  });
  if (!additionalContext) return;

  emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const previous = readStatus();
    writeStatus({ lastFetchError: message, lastFetchAt: previous.lastFetchAt });
  } catch {
    // Status persistence is advisory.
  }
  process.exit(0);
});
