/**
 * Direct integration tests for NLI scorer.
 * Run with: node --experimental-specifier-resolution=node src/hooks/__tests__/run-nli-tests.mjs
 * 
 * Uses the compiled JS output (run `npm run build` first).
 */

import { scoreConcepts, hasSalientConcepts, getSalientLabels, DEFAULT_CONCEPT_LABELS, NON_SALIENT_LABELS } from "../../../dist/hooks/nli-scorer.js";

let passed = 0;
let failed = 0;

function assert(condition, name, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log("\n🧪 NLI Scorer Integration Tests (real DeBERTa model)\n");
  console.log("Loading model (first run downloads ~22MB)...\n");

  // ── Salient messages ─────────────────────────────────────────────

  console.log("── Salient messages (should trigger retrieval/storage) ──\n");

  {
    console.log('Test: PAT disambiguation');
    const scores = await scoreConcepts(
      "the GithubPat token is for bh-ai repo, the openclaw-plugin-pat is for openclaw-plugins"
    );
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(hasSalientConcepts(scores, 0.5), "Has salient concepts above 0.5");
  }

  {
    console.log('\nTest: Anniversary reminder');
    const scores = await scoreConcepts("remember my anniversary is March 5th");
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(hasSalientConcepts(scores, 0.5), "Has salient concepts above 0.5");
    const pf = scores.find(s => s.label === "personal fact");
    assert(pf && pf.score > 0.3, "Personal fact scores > 0.3", pf ? `score=${pf.score.toFixed(3)}` : "not found");
  }

  {
    console.log('\nTest: Architectural decision');
    const scores = await scoreConcepts(
      "we decided to replace Haiku with DeBERTa for saliency scoring, zero API calls"
    );
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(hasSalientConcepts(scores, 0.5), "Has salient concepts above 0.5");
    const dec = scores.find(s => s.label === "decision");
    assert(dec && dec.score > 0.3, "Decision scores > 0.3", dec ? `score=${dec.score.toFixed(3)}` : "not found");
  }

  {
    console.log('\nTest: Explicit preference');
    const scores = await scoreConcepts(
      "I always want you to challenge my assumptions and play devil's advocate"
    );
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(hasSalientConcepts(scores, 0.5), "Has salient concepts above 0.5");
    const pref = scores.find(s => s.label === "preference");
    // Threshold lowered from 0.3 to 0.2: expanded DEFAULT_CONCEPT_LABELS in eca8862
    // (2026-03-05) added competing labels that redistribute multi-label NLI confidence.
    // Tracked for thorough rework in openclaw-vestige-32a.
    assert(pref && pref.score > 0.2, "Preference scores > 0.2", pref ? `score=${pref.score.toFixed(3)}` : "not found");
  }

  {
    console.log('\nTest: Task instruction');
    const scores = await scoreConcepts(
      "please add tests and actually run them, don't guess what the models would say"
    );
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(hasSalientConcepts(scores, 0.5), "Has salient concepts above 0.5");
    const task = scores.find(s => s.label === "task instruction");
    assert(task && task.score > 0.3, "Task instruction scores > 0.3", task ? `score=${task.score.toFixed(3)}` : "not found");
  }

  {
    console.log('\nTest: Commitment / promise');
    const scores = await scoreConcepts(
      "I'll have the PR ready by end of day tomorrow, I promise"
    );
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(hasSalientConcepts(scores, 0.5), "Has salient concepts above 0.5");
    const commit = scores.find(s => s.label === "commitment or promise");
    assert(commit && commit.score > 0.3, "Commitment scores > 0.3", commit ? `score=${commit.score.toFixed(3)}` : "not found");
  }

  {
    console.log("\nTest: Anisha's actual PAT correction message");
    const scores = await scoreConcepts(
      "there are two PATs in 1pass. Try both out? the GithubPat token is for bh-ai repo, the openclaw-plugin-pat is for openclaw-plugins"
    );
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(hasSalientConcepts(scores, 0.5), "Has salient concepts above 0.5");
  }

  // ── Non-salient messages ─────────────────────────────────────────

  console.log("\n── Non-salient messages (should NOT trigger retrieval/storage) ──\n");

  {
    console.log("Test: Casual greeting");
    const scores = await scoreConcepts("hey, what's up?");
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(!hasSalientConcepts(scores, 0.5), "No salient concepts above 0.5");
  }

  {
    console.log("\nTest: Simple acknowledgment (length gate: <25 chars → all zeros)");
    const scores = await scoreConcepts("ok sounds good thanks");
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(!hasSalientConcepts(scores, 0.5), "No salient concepts above 0.5");
    assert(scores.every(s => s.score === 0.0), "All scores are 0.0 (length gate)");
  }

  {
    console.log("\nTest: Lol (length gate: <25 chars → all zeros)");
    const scores = await scoreConcepts("lol");
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(!hasSalientConcepts(scores, 0.5), "No salient concepts above 0.5");
    assert(scores.every(s => s.score === 0.0), "All scores are 0.0 (length gate)");
  }

  {
    console.log("\nTest: Simple yes (length gate: <25 chars → all zeros)");
    const scores = await scoreConcepts("yes");
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(!hasSalientConcepts(scores, 0.5), "No salient concepts above 0.5");
    assert(scores.every(s => s.score === 0.0), "All scores are 0.0 (length gate)");
  }

  // ── Length gate boundary tests ────────────────────────────────────

  console.log("\n── Length gate boundary tests ──\n");

  {
    console.log("Test: Exactly 24 chars → length gate (all zeros)");
    const text24 = "abcdefghijklmnopqrstuvwx"; // exactly 24 chars
    assert(text24.length === 24, `Text is 24 chars (got ${text24.length})`);
    const scores = await scoreConcepts(text24);
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(scores.every(s => s.score === 0.0), "All scores are 0.0 (below 25 char threshold)");
  }

  {
    console.log("\nTest: Exactly 25 chars → model scores (not all zeros)");
    const text25 = "remember my cat name is X"; // exactly 25 chars
    assert(text25.length === 25, `Text is 25 chars (got ${text25.length})`);
    const scores = await scoreConcepts(text25);
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(scores.some(s => s.score > 0.0), "At least one score > 0.0 (model was invoked)");
  }

  // ── Edge cases ───────────────────────────────────────────────────

  console.log("\n── Edge cases ──\n");

  {
    console.log("Test: Custom concept labels (antibody domain)");
    const customLabels = ["antibody engineering", "machine learning", "casual chat"];
    const scores = await scoreConcepts(
      "the VHH showed improved thermal stability after humanization",
      customLabels
    );
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    assert(scores.length === customLabels.length, "Returns scores for all custom labels");
    assert(scores[0].label === "antibody engineering", "Antibody engineering scores highest", `got: ${scores[0].label}`);
  }

  {
    console.log("\nTest: getSalientLabels excludes non-salient labels");
    const scores = await scoreConcepts(
      "hey thanks for remembering my birthday is June 5th"
    );
    console.log("  Scores:", scores.map(s => `${s.label}: ${s.score.toFixed(3)}`).join(", "));
    const salientLabels = getSalientLabels(scores, 0.5);
    console.log("  Salient labels:", salientLabels);
    const hasNonSalient = salientLabels.some(l => NON_SALIENT_LABELS.has(l));
    assert(!hasNonSalient, "No non-salient labels in getSalientLabels output");
  }

  {
    console.log("\nTest: All scores between 0 and 1");
    const scores = await scoreConcepts("let's discuss the architecture");
    assert(scores.length === DEFAULT_CONCEPT_LABELS.length, `Returns ${DEFAULT_CONCEPT_LABELS.length} scores`);
    const allValid = scores.every(s => s.score >= 0 && s.score <= 1);
    assert(allValid, "All scores in [0, 1] range");
  }

  // ── Summary ──────────────────────────────────────────────────────

  console.log(`\n${"═".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${"═".repeat(50)}\n`);

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
