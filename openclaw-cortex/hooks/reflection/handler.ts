import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import https from "https";
import { URL } from "url";

// ── Paths ──────────────────────────────────────────────────────────────
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || join(process.env.HOME || "~", ".openclaw/workspace");
const MEMORY_DIR = join(WORKSPACE, "memory");
const TASK_QUEUE_PATH = join(MEMORY_DIR, "task-queue.json");
const FEEDBACK_PATH = join(MEMORY_DIR, "feedback.json");
const BOUNDARIES_PATH = join(WORKSPACE, "boundaries.json");
const REFLECTION_LOG_PATH = join(MEMORY_DIR, "reflection-log.json");
const CONTEXT_PATH = join(MEMORY_DIR, "cortex-context.json");
const AUTH_PROFILES_PATH = join(process.env.HOME || "~", ".openclaw/agents/main/agent/auth-profiles.json");
const OPENCLAW_CONFIG_PATH = join(process.env.HOME || "~", ".openclaw/openclaw.json");

const ANISHA_ID = "U06T3449W9H";
const matchesAnisha = (id: string | undefined) =>
  id === ANISHA_ID || id === `slack:${ANISHA_ID}` || id?.endsWith(ANISHA_ID) || false;
const CLASSIFIER_MODEL = "claude-3-haiku-20240307";

// ── Types ──────────────────────────────────────────────────────────────
interface Classification {
  type: "task" | "boundary" | "feedback-positive" | "feedback-negative" | "decision" | "info";
  summary: string;
  action_items: string[];
  vestige_worthy: boolean;
  confidence: number;
}

interface ContextEntry {
  timestamp: string;
  from: string;
  content: string;
}

interface VestigeConfig {
  serverUrl: string;
  authToken: string;
}

// ── Helpers ────────────────────────────────────────────────────────────
function ensureDir() {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function loadJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return fallback; }
}

function saveJson(path: string, data: unknown) {
  ensureDir();
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function appendToArray(path: string, entry: unknown, maxEntries = 500) {
  const arr = loadJson<unknown[]>(path, []);
  arr.push(entry);
  saveJson(path, arr.length > maxEntries ? arr.slice(-maxEntries) : arr);
}

function getApiKey(): string | null {
  try {
    const profiles = JSON.parse(readFileSync(AUTH_PROFILES_PATH, "utf-8"));
    return profiles?.profiles?.["anthropic:default"]?.key || null;
  } catch { return null; }
}

// ── Vestige Config ─────────────────────────────────────────────────────
function getVestigeConfig(): VestigeConfig | null {
  // Option 1: Read from openclaw.json
  try {
    const config = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, "utf-8"));
    const vestigeConfig = config?.plugins?.entries?.vestige?.config;
    if (vestigeConfig?.serverUrl && vestigeConfig?.authToken) {
      return { serverUrl: vestigeConfig.serverUrl, authToken: vestigeConfig.authToken };
    }
  } catch { /* fall through to env vars */ }

  // Option 2: Environment variables as fallback
  const serverUrl = process.env.VESTIGE_URL;
  const authToken = process.env.VESTIGE_TOKEN;
  if (serverUrl && authToken) {
    return { serverUrl, authToken };
  }

  return null;
}

// ── Vestige Smart Ingest (fire-and-forget) ─────────────────────────────
function vestigeSmartIngest(
  vestigeConfig: VestigeConfig,
  classification: Classification,
  messagePreview: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const url = new URL(`${vestigeConfig.serverUrl}/smart_ingest`);

      const body = JSON.stringify({
        content: `${classification.summary}\n\nContext: ${messagePreview}`,
        node_type: classification.type,
        tags: ["auto-ingested", "hook-cortex"],
        context: messagePreview,
      });

      const req = https.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${vestigeConfig.authToken}`,
          "X-Agent-Id": "telemachus",
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            console.log("[cortex] Vestige smart_ingest succeeded");
            resolve(true);
          } else {
            console.error(`[cortex] Vestige smart_ingest HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
            resolve(false);
          }
        });
      });

      req.on("error", (err) => {
        console.error("[cortex] Vestige smart_ingest error:", err.message);
        resolve(false);
      });

      // Timeout after 5s — don't block the hook
      req.setTimeout(5000, () => {
        console.error("[cortex] Vestige smart_ingest timeout");
        req.destroy();
        resolve(false);
      });

      req.write(body);
      req.end();
    } catch (err) {
      console.error("[cortex] Vestige smart_ingest unexpected error:", err instanceof Error ? err.message : String(err));
      resolve(false);
    }
  });
}

// ── Context Window ─────────────────────────────────────────────────────
function getContextWindow(): ContextEntry[] {
  return loadJson<ContextEntry[]>(CONTEXT_PATH, []);
}

function addToContext(entry: ContextEntry) {
  const ctx = getContextWindow();
  ctx.push(entry);
  saveJson(CONTEXT_PATH, ctx.length > 10 ? ctx.slice(-10) : ctx);
}

// ── Robust JSON extraction ─────────────────────────────────────────────
function extractJson(text: string): Classification | null {
  // Strategy 1: Try parsing the whole text as JSON
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && parsed.type) return parsed;
  } catch { /* fall through */ }

  // Strategy 2: Find JSON object with brace matching (handles nested braces)
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && parsed.type) return parsed;
        } catch { /* try next closing brace */ }
      }
    }
  }

  return null;
}

// ── LLM Call ───────────────────────────────────────────────────────────
function callClaude(apiKey: string, content: string, context: ContextEntry[]): Promise<Classification> {
  return new Promise((resolve, reject) => {
    const contextBlock = context.length > 0
      ? `\n\nRecent conversation context (for reference):\n${context.slice(-5).map(c => `[${c.from}]: ${c.content}`).join("\n")}\n\n`
      : "";

    const systemPrompt = `You are a message classifier for an AI assistant's reflection system.
Classify the user's message into exactly one category and extract structured data.
${contextBlock}
Categories:
- "task": The user is asking the assistant to DO something (build, fix, check, write, send, etc.)
- "boundary": The user is setting a rule about how the assistant should behave (don't do X, always do Y, stop doing Z)
- "feedback-positive": The user is expressing approval, praise, or satisfaction with something the assistant did
- "feedback-negative": The user is expressing frustration, correction, or dissatisfaction
- "decision": The user is making or communicating a decision, preference, or factual statement worth remembering
- "info": Casual conversation, questions, or context that doesn't need action

IMPORTANT: Respond with ONLY a JSON object, no other text before or after:
{"type":"<category>","summary":"one-line distillation","action_items":["specific things to do"],"vestige_worthy":true|false,"confidence":0.0-1.0}`;

    const body = JSON.stringify({
      model: CLASSIFIER_MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content }],
      system: systemPrompt,
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.content?.[0]?.text || "";
          const classification = extractJson(text);
          if (classification) resolve(classification);
          else reject(new Error("No JSON in response: " + text.slice(0, 200)));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Action Handlers ────────────────────────────────────────────────────
function handleTask(classification: Classification, content: string, timestamp: string): string {
  const taskQueue = loadJson<{ tasks: any[]; meta: any }>(TASK_QUEUE_PATH, { tasks: [], meta: {} });
  taskQueue.tasks.push({
    id: `task-${Date.now()}`,
    description: classification.summary,
    action_items: classification.action_items,
    status: "pending",
    created: timestamp,
    completed: null,
    source_message: content.slice(0, 300),
  });
  saveJson(TASK_QUEUE_PATH, taskQueue);
  return `🧠 cortex → task: ${classification.summary}`;
}

function handleBoundary(classification: Classification, content: string): string {
  const boundaries = loadJson<{ boundaries: any[]; requests: any[] }>(BOUNDARIES_PATH, { boundaries: [], requests: [] });
  boundaries.boundaries.push({
    id: `boundary-${Date.now()}`,
    rule: classification.summary,
    type: "custom",
    enabled: true,
    enforced_by: ["pending — needs enforcement mechanism"],
    params: {},
    created: new Date().toISOString().split("T")[0],
    times_asked: 1,
    source_message: content.slice(0, 200),
    needs_review: true,
  });
  saveJson(BOUNDARIES_PATH, boundaries);
  return `🧠 cortex → boundary: ${classification.summary}`;
}

function handleFeedback(classification: Classification, content: string): string {
  const feedback = loadJson<{ entries: any[]; meta: any }>(FEEDBACK_PATH, { entries: [], meta: {} });
  feedback.entries.push({
    timestamp: new Date().toISOString(),
    type: classification.type === "feedback-positive" ? "positive" : "negative",
    summary: classification.summary,
    source_message: content.slice(0, 300),
  });
  if (feedback.entries.length > 500) feedback.entries = feedback.entries.slice(-500);
  saveJson(FEEDBACK_PATH, feedback);
  const emoji = classification.type === "feedback-positive" ? "👍" : "📝";
  return `🧠 cortex → ${emoji} feedback: ${classification.summary}`;
}

// ── Main Handler ───────────────────────────────────────────────────────
// NO DEBOUNCE — classify every message immediately.
// Cost: ~$0.001/msg. Accuracy + reliable status indicators > saving fractions of a cent.
const handler = async (event: {
  type: string;
  action: string;
  context: Record<string, unknown>;
  messages: string[];
}) => {
  if (event.type !== "message" || event.action !== "received") return;

  const from = event.context.from as string | undefined;
  const senderId = (event.context.metadata as any)?.senderId as string | undefined;
  if (!matchesAnisha(from) && !matchesAnisha(senderId)) return;

  const content = (event.context.content as string) || "";
  if (content.length < 3) return;

  const timestamp = new Date().toISOString();

  // Add to sliding context window
  addToContext({ timestamp, from: "Anisha", content: content.slice(0, 500) });

  // Get API key
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("[cortex] No Anthropic API key found");
    event.messages.push("🧠 cortex → ⚠️ no API key");
    return;
  }

  // Classify this single message
  let classification: Classification;
  try {
    const context = getContextWindow();
    classification = await callClaude(apiKey, content, context);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[cortex] Classification failed:", errMsg);
    // Log the error
    appendToArray(REFLECTION_LOG_PATH, {
      timestamp,
      message_count: 1,
      message_preview: content.slice(0, 200),
      classification: null,
      error: errMsg,
      actions_taken: [],
      vestige_ingested: false,
    }, 1000);
    // Still push a visible status so Anisha knows it failed
    event.messages.push(`🧠 cortex → ❌ classification failed`);
    return;
  }

  // Act on classification
  let statusMsg = "";
  try {
    switch (classification.type) {
      case "task":
        statusMsg = handleTask(classification, content, timestamp);
        break;
      case "boundary":
        statusMsg = handleBoundary(classification, content);
        break;
      case "feedback-positive":
      case "feedback-negative":
        statusMsg = handleFeedback(classification, content);
        break;
      case "decision":
        statusMsg = classification.vestige_worthy
          ? `🧠 cortex → decision (vestige-worthy): ${classification.summary}`
          : `🧠 cortex → decision: ${classification.summary}`;
        break;
      case "info":
        statusMsg = `🧠 cortex → info (no action)`;
        break;
    }
  } catch (err) {
    console.error("[cortex] Action handling failed:", err instanceof Error ? err.message : String(err));
    statusMsg = `🧠 cortex → ⚠️ action failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // ── Vestige auto-ingest (fire-and-forget) ────────────────────────────
  let vestigeIngested = false;
  if (classification.vestige_worthy) {
    const vestigeConfig = getVestigeConfig();
    if (vestigeConfig) {
      // Fire-and-forget: don't await, but track the result via .then()
      vestigeSmartIngest(vestigeConfig, classification, content.slice(0, 300))
        .then((success) => {
          if (success) {
            console.log(`[cortex] Vestige ingested: ${classification.summary.slice(0, 80)}`);
          }
        })
        .catch((err) => {
          console.error("[cortex] Vestige ingest promise error:", err);
        });
      // Optimistically mark as ingested since we fired the request
      vestigeIngested = true;
    } else {
      console.error("[cortex] Vestige config not found — skipping auto-ingest");
    }
  }

  // Log everything
  appendToArray(REFLECTION_LOG_PATH, {
    timestamp,
    message_count: 1,
    message_preview: content.slice(0, 200),
    classification,
    status_msg: statusMsg,
    actions_taken: statusMsg ? [statusMsg] : [],
    vestige_ingested: vestigeIngested,
  }, 1000);

  // ALWAYS push status indicator — visible to agent (and user via agent's responses)
  if (statusMsg) {
    event.messages.push(statusMsg);
  }
};

export default handler;
