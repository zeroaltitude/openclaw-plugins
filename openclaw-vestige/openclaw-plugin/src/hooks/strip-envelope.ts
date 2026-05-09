/**
 * Channel-envelope stripping for memory recall queries.
 *
 * OpenClaw's inbound message shaping wraps user-typed text in a metadata
 * envelope so the agent can see who/where/when. The shape (Slack here, but
 * Discord/Telegram/etc. follow the same v2 contract) is:
 *
 *     System (untrusted): [<timestamp>] <Channel> message in <subject> from <Sender>: <BODY>
 *
 *     Conversation info (untrusted metadata):
 *     ```json
 *     {...}
 *     ```
 *
 *     Sender (untrusted metadata):
 *     ```json
 *     {...}
 *     ```
 *
 *     <BODY repeat — sometimes>
 *
 * For memory recall we want just <BODY>. The envelope is boilerplate that
 * dominates a 200-char embedding slice and pulls cosine matches toward
 * any other Slack-formatted memory in the corpus instead of the actual
 * content.
 *
 * Strategy: aggressive regex replace. Strip the header line and every
 * "<Word> (untrusted metadata):" + fenced JSON block, wherever they appear.
 * Collapse leftover whitespace. If nothing matched (DM with no envelope,
 * raw prompt, etc.), the original text is returned unchanged after trim.
 *
 * Tracked: openclaw-vestige-tjh.
 */
export function stripPromptEnvelope(text: string): string {
  if (!text) return text;
  let out = text;

  // 1. Strip all "System (untrusted): [<timestamp>] <something> from <name>: "
  //    headers, wherever they appear (multi-message turns can stack them,
  //    sometimes with no separator between body and the next header). The
  //    [^:\n] character class keeps the match anchored to a single header
  //    line — the first `:` after `from <name>` ends the prefix. The shape
  //    is specific enough that false positives on real user text are
  //    vanishingly unlikely.
  out = out.replace(
    /System \(untrusted\):\s*\[[^\]]+\][^:\n]*:\s*/g,
    "",
  );

  // 2. Strip "<Word> (untrusted metadata):\n```json\n{...}\n```" blocks.
  //    Non-greedy ``` match closes on the first triple-backtick.
  out = out.replace(
    /[A-Z][\w ]* \(untrusted metadata\):\s*```(?:json|JSON)?\s*[\s\S]*?```\s*/g,
    "",
  );

  // 3. Collapse runs of blank lines so the resulting body reads naturally.
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}
