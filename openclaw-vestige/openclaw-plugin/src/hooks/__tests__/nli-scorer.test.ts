/**
 * Integration tests for NLI scorer — runs actual DeBERTa model inference.
 * These are NOT mocked — they download and run the real model.
 * First run will be slow (~10-30s for model download), subsequent runs ~1-2s.
 */

import { scoreConcepts, hasSalientConcepts, getSalientLabels, DEFAULT_CONCEPT_LABELS, NON_SALIENT_LABELS } from "../nli-scorer.js";

// Increase timeout for model download on first run
const TEST_TIMEOUT = 120_000;

describe("NLI Scorer — real model inference", () => {

  // ── Saliency detection ───────────────────────────────────────────────

  it("should score PAT disambiguation as salient", async () => {
    const scores = await scoreConcepts(
      "the GithubPat token is for bh-ai repo, the openclaw-plugin-pat is for openclaw-plugins",
    );
    console.log("PAT disambiguation scores:", JSON.stringify(scores, null, 2));
    expect(hasSalientConcepts(scores, 0.5)).toBe(true);
  }, TEST_TIMEOUT);

  it("should score 'remember my anniversary is March 5th' as salient", async () => {
    const scores = await scoreConcepts(
      "remember my anniversary is March 5th",
    );
    console.log("Anniversary scores:", JSON.stringify(scores, null, 2));
    expect(hasSalientConcepts(scores, 0.5)).toBe(true);
    // Should score high on personal fact
    const personalFact = scores.find(s => s.label === "personal fact");
    expect(personalFact).toBeDefined();
    expect(personalFact!.score).toBeGreaterThan(0.3);
  }, TEST_TIMEOUT);

  it("should score architectural decision as salient", async () => {
    const scores = await scoreConcepts(
      "we decided to replace Haiku with DeBERTa for saliency scoring, zero API calls",
    );
    console.log("Architecture decision scores:", JSON.stringify(scores, null, 2));
    expect(hasSalientConcepts(scores, 0.5)).toBe(true);
    const decision = scores.find(s => s.label === "decision");
    expect(decision).toBeDefined();
    expect(decision!.score).toBeGreaterThan(0.3);
  }, TEST_TIMEOUT);

  it("should score explicit preference as salient", async () => {
    const scores = await scoreConcepts(
      "I always want you to challenge my assumptions and play devil's advocate",
    );
    console.log("Preference scores:", JSON.stringify(scores, null, 2));
    expect(hasSalientConcepts(scores, 0.5)).toBe(true);
    const preference = scores.find(s => s.label === "preference");
    expect(preference).toBeDefined();
    expect(preference!.score).toBeGreaterThan(0.3);
  }, TEST_TIMEOUT);

  it("should score task instruction as salient", async () => {
    const scores = await scoreConcepts(
      "please add tests and actually run them, don't guess what the models would say",
    );
    console.log("Task instruction scores:", JSON.stringify(scores, null, 2));
    expect(hasSalientConcepts(scores, 0.5)).toBe(true);
    const task = scores.find(s => s.label === "task instruction");
    expect(task).toBeDefined();
    expect(task!.score).toBeGreaterThan(0.3);
  }, TEST_TIMEOUT);

  it("should score commitment as salient", async () => {
    const scores = await scoreConcepts(
      "I'll have the PR ready by end of day tomorrow, I promise",
    );
    console.log("Commitment scores:", JSON.stringify(scores, null, 2));
    expect(hasSalientConcepts(scores, 0.5)).toBe(true);
    const commitment = scores.find(s => s.label === "commitment or promise");
    expect(commitment).toBeDefined();
    expect(commitment!.score).toBeGreaterThan(0.3);
  }, TEST_TIMEOUT);

  // ── Non-salient messages (should NOT trigger retrieval/storage) ──────

  it("should score casual greeting as non-salient", async () => {
    const scores = await scoreConcepts("hey, what's up?");
    console.log("Greeting scores:", JSON.stringify(scores, null, 2));
    expect(hasSalientConcepts(scores, 0.5)).toBe(false);
  }, TEST_TIMEOUT);

  it("should score simple acknowledgment as non-salient", async () => {
    const scores = await scoreConcepts("ok sounds good thanks");
    console.log("Acknowledgment scores:", JSON.stringify(scores, null, 2));
    expect(hasSalientConcepts(scores, 0.5)).toBe(false);
  }, TEST_TIMEOUT);

  it("should score 'lol' as non-salient", async () => {
    const scores = await scoreConcepts("lol");
    console.log("Lol scores:", JSON.stringify(scores, null, 2));
    expect(hasSalientConcepts(scores, 0.5)).toBe(false);
  }, TEST_TIMEOUT);

  // ── Anisha's real message (the PAT correction) ──────────────────────

  it("should handle Anisha's actual PAT correction message", async () => {
    const scores = await scoreConcepts(
      "there are two PATs in 1pass. Try both out? the GithubPat token is for bh-ai repo, the openclaw-plugin-pat is for openclaw-plugins",
    );
    console.log("Anisha PAT correction scores:", JSON.stringify(scores, null, 2));
    // This should be salient — it's a factual correction + task instruction
    expect(hasSalientConcepts(scores, 0.5)).toBe(true);
  }, TEST_TIMEOUT);

  // ── Edge cases ───────────────────────────────────────────────────────

  it("should handle very short messages", async () => {
    const scores = await scoreConcepts("yes");
    console.log("Short message scores:", JSON.stringify(scores, null, 2));
    // "yes" is acknowledgment — shouldn't be salient
    expect(scores.length).toBe(DEFAULT_CONCEPT_LABELS.length);
  }, TEST_TIMEOUT);

  it("should return scores for all concept labels", async () => {
    const scores = await scoreConcepts("let's discuss the architecture");
    expect(scores.length).toBe(DEFAULT_CONCEPT_LABELS.length);
    // All scores should be between 0 and 1
    for (const s of scores) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(1);
    }
  }, TEST_TIMEOUT);

  it("should support custom concept labels", async () => {
    const customLabels = ["antibody engineering", "machine learning", "casual chat"];
    const scores = await scoreConcepts(
      "the VHH showed improved thermal stability after humanization",
      customLabels,
    );
    console.log("Custom labels scores:", JSON.stringify(scores, null, 2));
    expect(scores.length).toBe(customLabels.length);
    // Antibody engineering should score highest
    expect(scores[0].label).toBe("antibody engineering");
  }, TEST_TIMEOUT);

  // ── Helper function tests ────────────────────────────────────────────

  it("getSalientLabels should exclude non-salient labels", async () => {
    const scores = await scoreConcepts(
      "hey thanks for remembering my birthday is June 5th",
    );
    console.log("Mixed message scores:", JSON.stringify(scores, null, 2));
    const salientLabels = getSalientLabels(scores, 0.5);
    // Should not include casual greeting or acknowledgment even if they score high
    for (const label of salientLabels) {
      expect(NON_SALIENT_LABELS.has(label)).toBe(false);
    }
  }, TEST_TIMEOUT);
});
