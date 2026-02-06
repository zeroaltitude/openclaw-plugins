# Evaluation Protocol: Does Vestige Actually Help?

**Date:** 2026-02-06  
**Contributors:** Tabitha, Hatbot, Eddie Abrams

---

## Overview

Before we declare victory, we need to prove the Vestige integration materially improves agent performance. This document defines two measurement protocols:

1. **Breadth Protocol** — Does shared memory "lift all ships"?
2. **Depth Protocol** — Does individual agent performance improve over time?

The dream metric: **"How often does a human have to re-explain something they already said?"** If that goes down, we're winning.

---

## 1. Breadth Protocol: Collective Knowledge ("Lift All Ships")

### Test: Cross-Agent Knowledge Recall
- Agent A learns a fact during a conversation (e.g., "the Octet parser uses no leading zeros for wells")
- In a **separate session**, Agent B is asked a question that requires that fact
- **Measure:** Does Agent B retrieve it? How many turns before it surfaces?
- **Control:** Same test without Vestige (Agent B has no way to know)

### Test: Human Knowledge Propagation
- Eddie tells Tabitha a preference ("I prefer TypeScript over Python for new services")
- Later, Anisha's agent is asked to scaffold a new service
- **Measure:** Does it default to TypeScript? Does it cite the preference?

### Test: Expertise Routing
- Can agents surface each other's domain knowledge?
- Example: "Hatbot, what's the kinetics assay SOP?" (if only Tabitha learned it)

### Test: Cumulative Learning
- Does the shared pool get smarter over time?
- Track total useful memories vs. noise over weeks

### Breadth Metrics

| Metric | Description | Target |
|--------|-------------|--------|
| Cross-agent recall rate | % of facts learned by one agent that are successfully retrieved by another | >70% for high-salience facts |
| Propagation latency | Time between ingestion by Agent A and first retrieval by Agent B | <1 session |
| Relevance precision | Of retrieved memories, what % were actually useful to the task? | >80% |
| Knowledge coverage | How much of the shared pool is actually useful? | Increasing over time |
| Duplicate rate | Are we storing the same fact N times? | <10% duplication |
| Cross-agent answer rate | Can B answer what only A learned? | >50% within first week |

---

## 2. Depth Protocol: Individual Performance Over Time

### Test: Context Retention (Within Session)
- Ask about something from 20+ messages ago in the same session
- **Measure:** Accuracy and speed of recall
- Tests whether Vestige supplements the context window effectively

### Test: Cross-Session Recall
- Start a multi-session project (e.g., debugging a pipeline over 3 days)
- New session: ask about yesterday's work
- **Measure:** How much context does the agent retain across sessions? How many times does the human have to re-explain?
- **Control:** Same task type without Vestige (relying only on MEMORY.md)

### Test: Preference Accuracy
- "What's my preferred X?" across various domains (coding style, tools, communication preferences)
- **Measure:** Accuracy vs. ground truth

### Test: Correction Persistence
- Correct an agent on a fact ("No, we use gp3 not gp2 for EBS volumes")
- Over the next N sessions, check: does the agent use the corrected fact? Does it ever regress?
- Directly tests FSRS-6 decay + the demote/promote mechanisms

### Test: Context Window Efficiency
- For long conversations, measure: how many tokens of the context window are "wasted" on re-establishing known facts vs. doing new work?
- **With Vestige:** Agent retrieves known facts from memory, doesn't need them repeated
- **Without:** Human has to re-state context each session

### Depth Metrics

| Metric | Description | Target |
|--------|-------------|--------|
| Re-explanation rate | How often does the human repeat information the agent should already know? | 50%+ reduction |
| Correction regression rate | After being corrected, how often does the agent revert to the old fact? | <5% regression |
| Token efficiency | Ratio of novel/productive tokens to context-restatement tokens | Measurable improvement |
| Task completion speed | Wall-clock time for recurring task types (before vs. after) | Faster |
| Recall accuracy | Correct answers to memory challenge questions | >85% |
| Time-to-answer | Does the agent need to search files, or does it know immediately? | Decreasing |
| User correction rate ("Dory count") | How often do humans say "no, I told you X" | 50%+ reduction |

---

## 3. Experimental Design

### Timeline

```
Week 1-2:  Baseline measurements (no Vestige)
           - Run test suite against both agents
           - Establish "Dory count" baseline
           - Record re-explanation frequency

Week 3-4:  Vestige enabled, same test suite
           - Both agents connected to shared Vestige instance
           - Run identical tests, compare scores

Week 5+:   Longitudinal tracking
           - Monitor metrics over time
           - Track FSRS-6 decay/strengthening patterns
           - Watch for emergent shared knowledge effects
```

### Controls

- **Model differences:** Use the same underlying model for both test periods, or account for model changes
- **Prompt changes:** Freeze system prompts during evaluation periods
- **Time-of-day effects:** Run tests at consistent times
- **Task complexity:** Use standardized task categories

### A/B Within Team

Easiest practical approach: Run one agent with Vestige, one without, for two weeks. Same types of tasks, same humans. Compare:
- How often each agent needs re-prompting
- How often each surfaces relevant prior knowledge unprompted
- Subjective human rating: "Did the agent remember what it should have?"

### Memory Challenge Quiz

Create a set of 20 "memory challenge" questions based on real conversations from the past week:
- 10 factual (specific values, paths, decisions)
- 5 preferential (user preferences, style choices)
- 5 contextual (why was a decision made, what was the rationale)

Score both agents. Compare with and without Vestige.

---

## 4. Built-in Observability

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

## 5. Success Criteria

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

## 6. Open Questions

- How do we measure "knowledge quality" beyond recall accuracy?
- Should we weight cross-agent knowledge transfer differently for different memory types (facts vs. preferences vs. procedures)?
- How do we handle conflicting memories between agents (Agent A says X, Agent B says Y)?
- What's the right cadence for memory maintenance (consolidation runs)?
- Should the evaluation protocol itself be stored in Vestige as a meta-memory? 🤔
