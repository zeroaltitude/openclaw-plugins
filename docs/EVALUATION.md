# Evaluation Protocol: Does Vestige Actually Help?

**Date:** 2026-02-06  
**Contributors:** Tabitha, Hatbot, Anisha Keshavan, Eddie Abrams

---

## Overview

Before we declare victory, we need to prove the Vestige integration materially improves agent performance. This document defines two measurement categories and the experimental design to test them:

1. **Depth Protocol** — Does individual agent performance improve over time?
2. **Breadth Protocol** — Does shared memory "lift all ships"?

The dream metric: **"How often does a human have to re-explain something they already said?"** If that goes down, we're winning.

---

## 1. Depth Protocol: Individual Agent Performance

### 1.1 Context Retention (Within Session)

- Ask about something from 20+ messages ago in the same session
- **Measure:** Accuracy and speed of recall
- Tests whether Vestige supplements the context window effectively

### 1.2 Cross-Session Recall

- Start a multi-session project (e.g., debugging a pipeline over 3 days)
- New session: ask about yesterday's work
- **Measure:** How much context does the agent retain across sessions? How many times does the human have to re-explain?
- **Control:** Same task type without Vestige (relying only on MEMORY.md)

### 1.3 Preference Accuracy

- "What's my preferred X?" across various domains (coding style, tools, communication preferences)
- **Measure:** Accuracy vs. ground truth
- **Example:** "What EBS volume type do we use?" / "What's my preferred language for new services?"

### 1.4 Correction Persistence

- Correct an agent on a fact ("No, we use gp3 not gp2 for EBS volumes")
- Over the next N sessions, check: does the agent use the corrected fact? Does it ever regress?
- Directly tests FSRS-6 decay + the demote/promote mechanisms

### 1.5 Context Window Efficiency

- For long conversations, measure: how many tokens of the context window are "wasted" on re-establishing known facts vs. doing new work?
- **With Vestige:** Agent retrieves known facts from memory, doesn't need them repeated
- **Without:** Human has to re-state context each session

### Depth Metrics

| Metric | Description | Target |
|--------|-------------|--------|
| Re-explanation rate | How often does the human repeat info the agent should know? | 50%+ reduction |
| Correction regression rate | After correction, how often does the agent revert? | <5% regression |
| Token efficiency | Novel/productive tokens vs. context-restatement tokens | Measurable improvement |
| Task completion speed | Wall-clock time for recurring task types (before vs. after) | Faster |
| Recall accuracy | Correct answers to memory challenge questions | >85% |
| Time-to-answer | Does the agent search files, or know immediately? | Decreasing |
| Dory count | How often humans say "no, I told you X" | 50%+ reduction |

---

## 2. Breadth Protocol: Collective Knowledge ("Lift All Ships")

### 2.1 Cross-Agent Knowledge Recall

- Agent A learns a fact during a conversation (e.g., "the Octet parser uses no leading zeros for wells")
- In a **separate session**, Agent B is asked a question that requires that fact
- **Measure:** Does Agent B retrieve it? How many turns before it surfaces?
- **Control:** Same test without Vestige (Agent B has no way to know)

### 2.2 Human Knowledge Propagation

- Eddie tells Tabitha a preference ("I prefer TypeScript over Python for new services")
- Later, Anisha's agent is asked to scaffold a new service
- **Measure:** Does it default to TypeScript? Does it cite the preference?

### 2.3 Expertise Routing

- Can agents surface each other's domain knowledge?
- **Example:** "Hatbot, what's the kinetics assay SOP?" (if only Tabitha learned it)
- Tests whether the shared namespace enables cross-domain expertise

### 2.4 Cumulative Learning

- Does the shared pool get smarter over time?
- Track total useful memories vs. noise over weeks
- Every plugged-in OpenClaw instance contributes to a common dataset

### Breadth Metrics

| Metric | Description | Target |
|--------|-------------|--------|
| Cross-agent recall rate | % of facts from one agent retrievable by another | >70% for high-salience facts |
| Propagation latency | Time from Agent A ingestion to Agent B retrieval | <1 session |
| Relevance precision | Of retrieved memories, what % were useful? | >80% |
| Knowledge coverage | How much of shared pool is actually useful? | Increasing over time |
| Duplicate rate | Are we storing the same fact N times? | <10% duplication |
| Cross-agent answer rate | Can B answer what only A learned? | >50% within first week |

---

## 3. Automated Spaced Retrieval Testing (Anisha's Protocol)

Generate ground-truth Q&A pairs **at conversation time**, stored outside the memory system, then quiz agents at increasing intervals.

### How It Works

1. **At conversation time:** After each substantive exchange, automatically generate a question and its correct answer. Store this in a separate eval database (NOT in Vestige, NOT in memory files — this is ground truth, not agent memory).

2. **Schedule quizzes:** At t+1 day, t+7 days, t+30 days, ask the agent the question in a fresh session.

3. **Score:** Compare the agent's answer against ground truth. Record accuracy, confidence, and whether it cited Vestige.

4. **Compare:** Run the same quiz against the agent with Vestige enabled vs. disabled.

### What This Measures

- **Decay curves:** How does recall degrade over time? Does FSRS-6 match actual agent behavior?
- **Vestige vs. baseline:** At each time interval, how much better is Vestige recall vs. file-based memory?
- **Memory type sensitivity:** Do facts, preferences, and procedures decay at different rates?

### Automation

A cron job or heartbeat task could:
1. After each conversation, call an LLM to generate 1-3 Q&A pairs from the transcript
2. Store them in a SQLite eval DB with timestamps
3. At scheduled intervals, inject quiz questions into a test session
4. Score responses automatically (exact match + semantic similarity)
5. Produce weekly reports with decay curves

### Crowdsourced Eval Data

Since Vestige is centralized, every plugged-in OpenClaw instance contributes Q&A pairs to the common eval dataset automatically. The more agents participate, the richer and more diverse the test corpus becomes — no one has to manually write test cases. Normal team work generates the evaluation data.

This directly validates whether the cognitive science model (FSRS-6, calibrated on human flashcard data) is well-calibrated for LLM agent memory.

---

## 4. Baseline Measurement: Experimental Design Options

To evaluate properly, we need to compare against a baseline without the memory plugin. Several approaches, each with different tradeoffs:

### Option A: Plugin Toggle (Same Agent, Dual Run)

Don't use two separate agents — use the **same** agent, but for each quiz question, run it twice:
1. With Vestige plugin active (can query shared memory)
2. With Vestige plugin disabled (falls back to local files only)

Same model, same prompt, same question — only variable is memory access. The eval harness just toggles the plugin.

| Pros | Cons |
|------|------|
| Cleanest control (same agent, same model) | Each quiz costs 2x API calls |
| No separate agent to manage | Doesn't capture "organic" differences |
| No manual merging needed | |

**Best for:** Rigorous, automated A/B testing.

### Option B: Time-Split Baseline

- **Weeks 1-2:** All agents run normally (no Vestige). Generate Q&A pairs. Quiz at scheduled intervals — these become baseline scores.
- **Week 3+:** Enable Vestige. Continue generating Q&A pairs. Quiz at same intervals. Compare the two periods.

Baseline data is already "merged" because it's the same agents, same eval DB, just different time periods.

| Pros | Cons |
|------|------|
| Simple to implement | Less rigorous (time as confound) |
| No doubled costs | Model/prompt changes between periods |
| Natural workflow | Can't re-run baseline later |

**Best for:** Quick pragmatic start, especially pre-deployment.

### Option C: Shadow Mode (Ingest Everything, Selective Retrieval)

Vestige runs and ingests everything, but **retrieval is silenced** for one agent. That agent generates answers from local files only. The eval harness also queries Vestige to see what it *would have* returned, and scores both.

| Pros | Cons |
|------|------|
| Shared pool still grows (no data loss) | More complex eval harness |
| Clean simultaneous A/B | Need to instrument retrieval layer |
| Scientifically rigorous | |

**Best for:** Ongoing longitudinal study after initial deployment.

### Option D: Cross-Agent A/B (Hatbot's Proposal)

Run one agent (e.g., Tabitha) with Vestige enabled, another (e.g., Hatbot) without, for two weeks. Same types of tasks, same humans.

| Pros | Cons |
|------|------|
| Real-world usage patterns | Different agents may have different baselines |
| Easy to set up | Agent personality as confound |
| Captures organic behavior | Control agent's learnings need manual merging later |

**Best for:** Qualitative "feel" testing + subjective human ratings.

### Recommended Approach

**Start with Option B** (time-split) for the initial baseline, then **switch to Option A** (plugin toggle) for ongoing automated evaluation. Use **Option D** selectively for qualitative validation.

### Controls to Maintain

- **Model differences:** Use the same underlying model for both test periods, or account for changes
- **Prompt changes:** Freeze system prompts during evaluation periods
- **Time-of-day effects:** Run tests at consistent times
- **Task complexity:** Use standardized task categories

---

## 5. Memory Challenge Quiz

Create a set of 20 "memory challenge" questions based on real conversations from the past week:
- 10 factual (specific values, paths, decisions)
- 5 preferential (user preferences, style choices)
- 5 contextual (why was a decision made, what was the rationale)

Score both agents. Compare with and without Vestige.

---

## 6. Built-in Observability

Vestige provides built-in stats we can baseline and track:

```bash
vestige stats              # Memory count, total ingested
vestige stats --tagging    # Retention distribution (active/dormant/silent/unavailable)
vestige stats --states     # Cognitive state distribution
```

### Key Vestige Metrics to Track Over Time

- **Total memories** — Growing, but not unboundedly
- **Active memories** (retention ≥70%) — Should be the most-used facts
- **Dormant memories** (40-70%) — Knowledge that's aging but recoverable
- **Silent memories** (<40%) — Fading knowledge (natural and healthy)
- **Promote/demote ratio** — Are corrections happening? Are they sticking?
- **Prediction error gating stats** — CREATE vs UPDATE vs REINFORCE ratio (indicates dedup effectiveness)

---

## 7. Success Criteria

### Minimum Viable Success
- Cross-agent recall works at all (Agent B can answer using Agent A's knowledge)
- Re-explanation rate drops noticeably (human-reported)
- Corrections persist across sessions

### Strong Success
- >70% cross-agent recall on high-salience facts
- >50% reduction in re-explanation rate
- Agents proactively surface relevant shared knowledge without being asked
- Vestige memory pool grows steadily without excessive duplication

### Exceptional Success
- Agents can reconstruct project context from memory alone (no human re-prompting)
- New agents onboarded to the team immediately benefit from existing knowledge pool
- Humans report the agents "feel like they actually know our team"

---

## 8. Open Questions

- How do we measure "knowledge quality" beyond recall accuracy?
- Should we weight cross-agent knowledge transfer differently for different memory types (facts vs. preferences vs. procedures)?
- How do we handle conflicting memories between agents (Agent A says X, Agent B says Y)?
- What's the right cadence for memory maintenance (consolidation runs)?
- Can we publish anonymized eval results as part of the open-source release? ("Here's how shared cognitive memory performs across N agents over M weeks" — potentially paper-worthy.)
- Should the evaluation protocol itself be stored in Vestige as a meta-memory? 🤔
