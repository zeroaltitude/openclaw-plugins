import { existsSync } from "fs";
import { join } from "path";
import { ensureDir, loadJson, saveJson } from "../../lib/utils";

// ── Paths ──────────────────────────────────────────────────────────────
const WORKSPACE =
  process.env.OPENCLAW_WORKSPACE ||
  join(process.env.HOME || "~", ".openclaw/workspace");
const MEMORY_DIR = join(WORKSPACE, "memory");
const STATE_PATH = join(MEMORY_DIR, "context-monitor-state.json");
const CONTEXT_PATH = join(MEMORY_DIR, "cortex-context.json");

// ── Config ─────────────────────────────────────────────────────────────
const MESSAGE_THRESHOLD = parseInt(
  process.env.CORTEX_CONTEXT_THRESHOLD || "25",
  10
);
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ── Types ──────────────────────────────────────────────────────────────
interface ThreadState {
  messageCount: number;
  firstMessageTs: string;
  lastAlertTs: string | null;
}

interface StateFile {
  [threadId: string]: ThreadState;
}

interface ContextEntry {
  timestamp: string;
  from: string;
  content: string;
}

// ── State TTL Pruning ──────────────────────────────────────────────────
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function pruneStaleThreads(state: StateFile): StateFile {
  const cutoff = Date.now() - STATE_TTL_MS;
  const pruned: StateFile = {};
  for (const [id, thread] of Object.entries(state)) {
    const lastActivity = thread.lastAlertTs
      ? new Date(thread.lastAlertTs).getTime()
      : new Date(thread.firstMessageTs).getTime();
    if (lastActivity >= cutoff) {
      pruned[id] = thread;
    }
  }
  return pruned;
}

// ── Thread ID Resolution ───────────────────────────────────────────────
function resolveThreadId(context: Record<string, unknown>): string {
  const metadata = context.metadata as Record<string, unknown> | undefined;

  // Determine the chat-level prefix
  const chatId = context.chatId || metadata?.chat_id;
  const chatPrefix = chatId ? String(chatId) : null;

  // Determine the thread/topic-level suffix
  const threadOrTopic = metadata?.topic_id || context.threadId;
  const suffix = threadOrTopic ? String(threadOrTopic) : null;

  // Build composite key
  if (chatPrefix && suffix) return `${chatPrefix}:${suffix}`;
  if (chatPrefix) return chatPrefix;
  if (suffix) return suffix;

  console.warn("[cortex/context-monitor] No chat/thread/topic ID found — falling back to 'default'");
  return "default";
}

// ── Summary Builder ────────────────────────────────────────────────────
function buildSummaryPrompt(recentMessages: ContextEntry[]): string {
  if (recentMessages.length === 0) {
    return "Continuing from previous thread — please share the current context so I can pick up where we left off.";
  }

  // Extract topic from the most common nouns/phrases in recent messages
  const allContent = recentMessages.map((m) => m.content).join(" ");
  const firstMsg = recentMessages[0].content.slice(0, 100);
  const lastMsg = recentMessages[recentMessages.length - 1].content.slice(0, 100);

  // Build bullet points from recent messages
  const bullets = recentMessages
    .map((m) => {
      const preview =
        m.content.length > 120 ? m.content.slice(0, 120) + "…" : m.content;
      return `- [${m.from}]: ${preview}`;
    })
    .join("\n");

  // Identify last action-like message (contains verbs/imperatives)
  const actionKeywords =
    /\b(fix|build|create|update|check|review|deploy|test|add|remove|change|implement|write|send|push|merge)\b/i;
  const lastAction = [...recentMessages]
    .reverse()
    .find((m) => actionKeywords.test(m.content));

  const currentTask = lastAction
    ? `Current task: ${lastAction.content.slice(0, 150)}`
    : `Last discussed: ${lastMsg}`;

  return [
    `Continuing from previous thread (it got long, so starting fresh).`,
    ``,
    `Key context from recent messages:`,
    bullets,
    ``,
    currentTask,
  ].join("\n");
}

// ── Main Handler ───────────────────────────────────────────────────────
const handler = async (event: {
  type: string;
  action: string;
  context: Record<string, unknown>;
  messages: string[];
}) => {
  if (event.type !== "message" || event.action !== "received") return;

  try {
    ensureDir(MEMORY_DIR);
    const threadId = resolveThreadId(event.context);
    const now = Date.now();
    const state = pruneStaleThreads(loadJson<StateFile>(STATE_PATH, {}));

    // Initialize or increment thread state
    if (!state[threadId]) {
      state[threadId] = {
        messageCount: 1,
        firstMessageTs: new Date(now).toISOString(),
        lastAlertTs: null,
      };
      saveJson(STATE_PATH, state);
      return;
    }

    state[threadId].messageCount++;
    const thread = state[threadId];

    // Check threshold
    if (thread.messageCount < MESSAGE_THRESHOLD) {
      saveJson(STATE_PATH, state);
      return;
    }

    // Check cooldown — don't spam alerts
    if (
      thread.lastAlertTs &&
      now - new Date(thread.lastAlertTs).getTime() < ALERT_COOLDOWN_MS
    ) {
      saveJson(STATE_PATH, state);
      return;
    }

    // Build alert with summary from reflection hook's context window
    const hasContextFile = existsSync(CONTEXT_PATH);
    const contextWindow = hasContextFile ? loadJson<ContextEntry[]>(CONTEXT_PATH, []) : [];
    const recentMessages = contextWindow.slice(-5);
    let summaryPrompt = buildSummaryPrompt(recentMessages);
    if (!hasContextFile || contextWindow.length === 0) {
      summaryPrompt += "\n\nNote: Install the cortex reflection hook for richer context summaries.";
    }

    const alertMessage = [
      `🧠 This thread has ${thread.messageCount} messages. Consider starting a new one. Here's a prompt to carry context forward:`,
      ``,
      "```",
      summaryPrompt,
      "```",
    ].join("\n");

    // Update alert timestamp
    state[threadId].lastAlertTs = new Date(now).toISOString();
    saveJson(STATE_PATH, state);

    // Push as system event so the agent sees it
    event.messages.push(alertMessage);
  } catch (err) {
    // Fire-and-forget: log and continue
    console.error(
      "[cortex/context-monitor] Error:",
      err instanceof Error ? err.message : String(err)
    );
  }
};

export default handler;
