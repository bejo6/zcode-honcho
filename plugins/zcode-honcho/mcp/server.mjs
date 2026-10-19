#!/usr/bin/env node
/**
 * Honcho memory MCP server — speaks the Model Context Protocol over stdio
 * (newline-delimited JSON-RPC 2.0), zero dependencies.
 *
 * Tools:
 *   honcho_search    look something up — raw messages AND derived conclusions
 *   honcho_chat      a question of judgment about the user (slow)
 *   honcho_remember  save a durable fact, preference, or decision
 *   honcho_status    peer, workspace, session, queue, last sync — for `/honcho`
 *   honcho_flush     sync the capture queue now
 *
 * The server stays alive across the session; each tool call re-reads
 * `~/.honcho/config.json`, so config edits apply without a restart.
 */

import { createInterface } from "node:readline";
import { loadConfig, sessionUrl, SESSION_STRATEGIES } from "../hooks/lib/config.mjs";
import { Gateway } from "../hooks/lib/gateway.mjs";
import { pendingCount, readStatus } from "../hooks/lib/state.mjs";
import { flushAll } from "../hooks/lib/flush.mjs";

const SERVER_INFO = { name: "honcho-memory", version: "0.1.0" };

function text(result) {
  return { content: [{ type: "text", text: result.text ?? String(result) }] };
}

function errorText(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function gateway(config) {
  return new Gateway(config, { timeoutMs: config.timeoutMs });
}

async function toolSearch(config, args) {
  const query = String(args?.query ?? "").trim();
  if (!query) return text({ text: "Search query was empty." });
  const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 10);
  // Both layers, in parallel. Messages alone miss everything the Deriver and
  // Dreamer inferred; conclusions alone miss what was actually said.
  const [messages, conclusions] = await Promise.allSettled([
    gateway(config).searchMessages(query, limit),
    gateway(config).searchConclusions(query, limit),
  ]);
  const lines = [];
  if (messages.status === "fulfilled") lines.push(...messages.value);
  else lines.push(`[message search failed: ${messages.reason?.message ?? messages.reason}]`);
  if (conclusions.status === "fulfilled") lines.push(...conclusions.value);
  else lines.push(`[conclusion search failed: ${conclusions.reason?.message ?? conclusions.reason}]`);
  return text({ text: lines.length ? lines.join("\n") : "No results in messages or conclusions." });
}

async function toolChat(config, args) {
  const query = String(args?.query ?? "").trim();
  if (!query) return text({ text: "Question was empty." });
  const answer = await gateway(config).chat(query);
  return text({ text: answer || "Honcho has nothing relevant on that yet." });
}

async function toolRemember(config, args) {
  const content = String(args?.content ?? "").trim();
  if (!content) return text({ text: "Nothing to remember — `content` was empty." });
  const session = await gateway(config).remember(content, process.cwd());
  return text({ text: `Saved to Honcho memory (session ${session}).` });
}

function ago(at) {
  if (!at) return "never";
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

async function toolStatus(config) {
  const cwd = process.cwd();
  const name = gateway(config).currentSessionName(cwd);
  const status = readStatus();
  const lines = [
    `honcho-memory ${SERVER_INFO.version}`,
    `enabled: ${config.enabled ? "yes" : "no (config.enabled)"}`,
    `api key: ${config.apiKey ? "configured" : "MISSING — set HONCHO_API_KEY or auth.apiKey in the config"}`,
    `peer: ${config.peerName} · ai peer: ${config.aiPeer} · mode: ${config.observationMode}`,
    `workspace: ${config.workspace}`,
    `session: ${name} (strategy ${config.sessionStrategy}; cwd ${cwd})`,
    `dashboard: ${sessionUrl(config.workspace, name)}`,
    `capture: ${config.capture.saveMessages ? `on${config.capture.saveToolUse ? " +tools" : ""}` : "off"} · ${pendingCount()} message(s) pending`,
    `injection: sessionStart [${config.injection.sessionStart.join(", ")}] · perTurn [${config.injection.perTurn.join(", ") || "none"}]`,
    `last memory fetch: ${ago(status.lastFetchAt)}${status.lastFetchError ? ` — error: ${status.lastFetchError}` : ""}`,
    `last sync: ${ago(status.lastFlushedAt)}${status.lastError ? ` — error: ${status.lastError}` : ""}`,
    `config file: ${config.configFile}`,
    `session strategies available: ${SESSION_STRATEGIES.join(", ")}`,
  ];
  return text({ text: lines.join("\n") });
}

async function toolFlush(config) {
  const result = await flushAll({ config });
  if (!result.files) return text({ text: "Nothing pending — the capture queue is empty." });
  const parts = [`uploaded ${result.uploaded} message(s)`];
  if (result.failed) parts.push(`${result.failed} deferred (will retry): ${result.error ?? "unknown error"}`);
  return text({ text: parts.join("; ") + "." });
}

const TOOLS = [
  {
    name: "honcho_search",
    description:
      "Search the user's Honcho memory across all past sessions. Returns both raw messages and derived " +
      "conclusions. Use when you need history beyond what was already injected into context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query to find relevant information from past sessions." },
        limit: { type: "number", description: "Results per source (default 5, max 10)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "honcho_chat",
    description:
      "Ask Honcho a reasoned question about the user, answered over everything it has learned across all " +
      "sessions. Use for questions of judgment or preference — how they like to work, what they would " +
      "prefer — rather than for looking up something that was said. Slow: 30s to minutes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The question to ask about the user based on their history." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "honcho_remember",
    description:
      "Save a durable fact, preference, or decision about the user to Honcho so it survives into future " +
      "sessions. Use when the user states something worth carrying forward, not for transient task detail. " +
      "One fact per call, phrased to still make sense months from now.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The information to remember about the user for future sessions." },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "honcho_status",
    description:
      "Report the Honcho memory integration's live status: enabled state, peer and workspace, the resolved " +
      "session for the current directory, capture queue depth, and the last sync/fetch with any errors.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "honcho_flush",
    description: "Upload everything currently queued by turn capture to Honcho immediately.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function callTool(name, args) {
  // Load fresh per call so config edits apply without a server restart.
  const config = loadConfig();
  switch (name) {
    case "honcho_search":
      return toolSearch(config, args);
    case "honcho_chat":
      return toolChat(config, args);
    case "honcho_remember":
      return toolRemember(config, args);
    case "honcho_status":
      return toolStatus(config);
    case "honcho_flush":
      return toolFlush(config);
    default:
      return errorText(`Unknown tool: ${name}`);
  }
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // Not JSON — ignore the line rather than die.
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  try {
    if (method === "initialize") {
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    } else if (method === "ping") {
      reply(id, {});
    } else if (method === "tools/list") {
      reply(id, { tools: TOOLS });
    } else if (method === "resources/list") {
      reply(id, { resources: [] });
    } else if (method === "prompts/list") {
      reply(id, { prompts: [] });
    } else if (method === "tools/call") {
      callTool(params?.name, params?.arguments)
        .then((result) => reply(id, result))
        .catch((error) => {
          reply(id, errorText(error instanceof Error ? error.message : String(error)));
        });
    } else if (method === "resources/templates/list") {
      reply(id, { resourceTemplates: [] });
    } else if (isNotification) {
      // initialized, cancelled, etc. — nothing to answer.
    } else {
      replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (!isNotification) replyError(id, -32603, error instanceof Error ? error.message : String(error));
  }
});

// stdin close = the host is shutting the server down.
rl.on("close", () => process.exit(0));
