/**
 * Hermes / dsh / cursor-honcho aligned per-turn injection.
 *
 * Turn 1 may wait ~5s for session.context() (+ dialectic when due).
 * Later turns serve the cached block and refresh in a detached background
 * process when the TTL expires. Dialectic cadence is turn-based, not TTL-based.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Gateway } from "./gateway.mjs";
import { renderMemory, DIRECTIVES } from "./render.mjs";
import {
  loadConfig,
  FIRST_TURN_BUDGET_MS,
  REFRESH_BUDGET_MS,
  DIALECTIC_BUDGET_MS,
} from "./config.mjs";
import { readMemoryState, writeMemoryState, stateDir } from "./state.mjs";

const BG_FILE = fileURLToPath(new URL("../bg.mjs", import.meta.url));
const TRIVIAL_PROMPT = /^(y|n|yes|no|ok|okay|sure|thanks|thank you|thx|\.|\,)$/i;

export async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function logLine(message) {
  try {
    const path = join(stateDir(), "hook.log");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${message}\n`, "utf-8");
  } catch {
    // Logging is advisory.
  }
}

function wantsPerTurnRefresh(config) {
  return config.injection.perTurn.includes("userContext");
}

function wantsDialectic(config) {
  return config.injection.perTurn.includes("dialectic");
}

function isStale(state, config) {
  if (!state.lastFetchAt) return true;
  return Date.now() - state.lastFetchAt > config.injection.cadence.ttlSeconds * 1000;
}

function shouldRunDialectic(state, config) {
  if (!wantsDialectic(config)) return false;
  const every = Math.max(1, config.injection.cadence.dialectic);
  return state.turnCount % every === 1 % every;
}

function isTrivial(prompt) {
  return TRIVIAL_PROMPT.test(String(prompt || "").trim());
}

function injectText(config, state) {
  const block = renderMemory(config, state.context, [], state.dialecticText);
  if (!block?.text) return null;
  if (config.injection.sessionStart.includes("directives")) {
    return `${DIRECTIVES}\n\n${block.text}`;
  }
  return block.text;
}

function sessionOf(input) {
  return input.session_id || input.sessionId || input.conversation_id || "unknown";
}

function cwdOf(input) {
  return input.cwd || input.project_dir || process.cwd();
}

/**
 * UserPromptSubmit: capture already queued; inject memory like Hermes/dsh.
 * Returns additionalContext string or null.
 */
export async function handlePerTurnInject(config, input, prompt) {
  if (!config.enabled || !config.apiKey) return null;
  if (!wantsPerTurnRefresh(config) && !wantsDialectic(config)) return null;

  const cwd = cwdOf(input);
  const sessionId = sessionOf(input);
  const state = readMemoryState(sessionId);
  state.sessionId = sessionId;
  state.turnCount += 1;
  const first = state.turnCount === 1;
  const trivial = isTrivial(prompt);
  const stale = isStale(state, config);
  const refresh = wantsPerTurnRefresh(config);
  const gateway = new Gateway(config, { timeoutMs: Math.min(config.timeoutMs, REFRESH_BUDGET_MS) });

  try {
    if (first && !trivial) {
      await withTimeout(
        (async () => {
          state.context = await gateway.fetchContext(cwd, sessionId, prompt);
          state.lastFetchAt = Date.now();
          state.lastError = null;
          if (shouldRunDialectic(state, config)) {
            const answer = await gateway.backgroundDialectic(cwd, sessionId, prompt);
            if (answer) state.dialecticText = answer;
            state.dialecticStartedAt = Date.now();
          }
        })(),
        FIRST_TURN_BUDGET_MS,
      );
    } else if (!trivial && refresh && stale) {
      spawnBackground({
        kind: "refresh",
        sessionId,
        cwd,
        prompt,
        awaitDialectic: false,
      });
      state.refreshingUntil = Date.now() + REFRESH_BUDGET_MS;
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    logLine(`inject turn ${state.turnCount} failed: ${state.lastError}`);
  }

  const dialecticCooldown = Date.now() - (state.dialecticStartedAt || 0) < 60_000;
  if (
    !trivial &&
    shouldRunDialectic(state, config) &&
    !(first && state.dialecticText) &&
    !dialecticCooldown
  ) {
    spawnBackground({
      kind: "dialectic",
      sessionId,
      cwd,
      prompt,
      awaitDialectic: true,
    });
    state.dialecticStartedAt = Date.now();
  }

  writeMemoryState(sessionId, state);
  const additional = injectText(config, state);
  if (additional) {
    logLine(
      `inject turn ${state.turnCount} ${additional.length} chars` +
        (first ? " (first)" : stale && refresh ? " (stale-cache)" : ""),
    );
  }
  return additional;
}

/** SessionStart: ensure peers, emit directives, warm the per-turn cache. */
export async function handleSessionStart(config, input) {
  if (!config.enabled || !config.apiKey) return null;

  const cwd = cwdOf(input);
  const sessionId = sessionOf(input);
  const gateway = new Gateway(config, { timeoutMs: Math.min(config.timeoutMs, 12_000) });

  try {
    await withTimeout(gateway.ensureSession(cwd, sessionId), 12_000);
  } catch (error) {
    logLine(`sessionStart ensure failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const state = readMemoryState(sessionId);
  state.sessionId = sessionId;
  writeMemoryState(sessionId, state);

  spawnBackground({
    kind: "refresh",
    sessionId,
    cwd,
    prompt: "",
    awaitDialectic: false,
  });

  if (config.injection.sessionStart.includes("directives")) {
    return DIRECTIVES;
  }
  return null;
}

export function spawnBackground(job) {
  const dir = join(stateDir(), "jobs");
  mkdirSync(dir, { recursive: true });
  const jobPath = join(dir, `job-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  try {
    writeFileSync(jobPath, JSON.stringify(job));
    const child = spawn(process.execPath, [BG_FILE, jobPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch {
    try {
      unlinkSync(jobPath);
    } catch {
      // ignore
    }
  }
}

/** Detached worker: refresh context and/or dialectic into the memory state file. */
export async function runBackgroundJob(jobPath) {
  let job;
  try {
    job = JSON.parse(readFileSync(jobPath, "utf-8"));
  } catch (error) {
    logLine(`bg job read failed: ${error}`);
    return;
  } finally {
    try {
      if (jobPath && existsSync(jobPath)) unlinkSync(jobPath);
    } catch {
      // ignore
    }
  }

  const config = loadConfig();
  if (!config.enabled || !config.apiKey) return;

  const state = readMemoryState(job.sessionId);
  state.sessionId = job.sessionId || state.sessionId;
  const gateway = new Gateway(config, { timeoutMs: Math.min(config.timeoutMs, REFRESH_BUDGET_MS) });

  try {
    if (job.kind === "refresh" || job.kind === "both") {
      const context = await withTimeout(
        gateway.fetchContext(job.cwd, job.sessionId, job.prompt || ""),
        REFRESH_BUDGET_MS,
      );
      state.context = context;
      state.lastFetchAt = Date.now();
      state.lastError = null;
      state.refreshingUntil = 0;
      logLine(`bg refresh ok ${job.sessionId}`);
    }
    if (job.kind === "dialectic" || (job.kind === "refresh" && job.awaitDialectic)) {
      const answer = await withTimeout(
        gateway.backgroundDialectic(job.cwd, job.sessionId, job.prompt || ""),
        DIALECTIC_BUDGET_MS,
      );
      if (answer) state.dialecticText = answer;
      state.dialecticStartedAt = Date.now();
      logLine(`bg dialectic ok ${job.sessionId} ${answer?.length || 0} chars`);
    }
  } catch (error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    state.refreshingUntil = 0;
    logLine(`bg ${job.kind} failed: ${state.lastError}`);
  }

  writeMemoryState(job.sessionId, state);
}
