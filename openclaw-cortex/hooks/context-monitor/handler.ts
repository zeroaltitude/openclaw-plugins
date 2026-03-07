import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

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

// ── Helpers ────────────────────────────────────────────────────────────
function ensureDir() {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function loadJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJson(path: string, data: unknown) {
  ensureDir();
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ── Thread ID Resolution ───────────────────────────────────────────────
function resolveThreadId(context: Record<string, unknown>): string {
  const metadata = context.metadata as Record<string, unknown> | undefined;
  if (metadata?.topic_id) return String(metadata.topic_id);
  if (context.threadId) return String(context.threadId);
  if (metadata?.chat_id) return String(metadata.chat_id);
  if (context.chatId) return String(context.chatId);
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
    const threadId = resolveThreadId(event.context);
    const now = Date.now();
    const state = loadJson<StateFile>(STATE_PATH, {});

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
    const contextWindow = loadJson<ContextEntry[]>(CONTEXT_PATH, []);
    const recentMessages = contextWindow.slice(-5);
    const summaryPrompt = buildSummaryPrompt(recentMessages);

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
