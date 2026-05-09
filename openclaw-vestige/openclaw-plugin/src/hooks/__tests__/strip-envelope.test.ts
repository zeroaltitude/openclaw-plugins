import { stripPromptEnvelope } from "../strip-envelope.js";

describe("stripPromptEnvelope", () => {
  it("returns empty string unchanged", () => {
    expect(stripPromptEnvelope("")).toBe("");
  });

  it("returns plain text unchanged (no envelope present)", () => {
    expect(stripPromptEnvelope("hello world")).toBe("hello world");
  });

  it("strips a single Slack envelope with both metadata blocks", () => {
    const raw = `System (untrusted): [2026-05-09 15:20:36 MST] Slack message in #cio-situation-room from Eddie Abrams: The quality of the responses seems not the best -- so, what was the query that got specifically sent to vestige, and what were the responses?

Conversation info (untrusted metadata):
\`\`\`json
{
  "chat_id": "channel:C0AG7JAG35G",
  "sender": "Eddie Abrams"
}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{
  "label": "Eddie Abrams"
}
\`\`\``;
    const out = stripPromptEnvelope(raw);
    expect(out).toBe(
      "The quality of the responses seems not the best -- so, what was the query that got specifically sent to vestige, and what were the responses?",
    );
  });

  it("strips a multi-message envelope (two stacked Slack messages)", () => {
    const raw = `System (untrusted): [2026-05-09 15:22:55 MST] Slack message in #cio from Eddie: Why did my question not get a response?

Conversation info (untrusted metadata):
\`\`\`json
{"a":1}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{"b":2}
\`\`\`

Why did my question not get a response?System (untrusted): [2026-05-09 15:23:13 MST] Slack message in #cio from Eddie: Also, provenance footers are not appearing.

Conversation info (untrusted metadata):
\`\`\`json
{"c":3}
\`\`\`

Sender (untrusted metadata):
\`\`\`json
{"d":4}
\`\`\``;
    const out = stripPromptEnvelope(raw);
    // The body repeat between blocks is preserved (we don't dedupe — that's
    // out of scope), but both envelope headers and all metadata blocks are
    // gone.
    expect(out).toContain("Why did my question not get a response?");
    expect(out).toContain("Also, provenance footers are not appearing.");
    expect(out).not.toContain("System (untrusted):");
    expect(out).not.toContain("Conversation info (untrusted metadata)");
    expect(out).not.toContain("Sender (untrusted metadata)");
    expect(out).not.toContain("```json");
  });

  it("preserves the body when envelope header has odd characters", () => {
    const raw = `System (untrusted): [2026-05-09 15:00 MST] Discord message in #general from Tabitha 🚘: ping

Sender (untrusted metadata):
\`\`\`json
{}
\`\`\``;
    expect(stripPromptEnvelope(raw)).toBe("ping");
  });

  it("returns trimmed body when no metadata blocks are present", () => {
    const raw = `System (untrusted): [2026-05-09 15:00 MST] Slack message in #x from Eddie: just the body, no metadata`;
    expect(stripPromptEnvelope(raw)).toBe("just the body, no metadata");
  });

  it("leaves a raw prompt with a casual 'untrusted metadata' substring alone", () => {
    // A user pasting a snippet that happens to contain the phrase
    // shouldn't trigger the metadata-block strip unless it's in the
    // canonical "<Word> (untrusted metadata):\n\`\`\`json ... \`\`\`" shape.
    const raw =
      "We talked about untrusted metadata in the design review yesterday.";
    expect(stripPromptEnvelope(raw)).toBe(raw);
  });
});
