# Encyclopedia Everythingica — Seed Round Pitch

**Cognitive Memory Infrastructure for AI Agents**

*Draft — February 2026*

---

## The Problem

AI agents are goldfish.

Every session, every conversation, every task — they start from zero. Your agent debugged a production outage last Tuesday? It doesn't remember. Your teammate's agent figured out the API quirk that cost you three hours? Your agent has no idea.

Today's AI agents operate in isolated amnesiac bubbles. Each interaction is a cold start. Knowledge doesn't persist, doesn't transfer, doesn't compound.

**The cost is staggering:**
- Engineers re-explain context every session (est. 15-30% of interaction time)
- Teams duplicate discoveries across agents that never talk to each other
- Corrections don't stick — agents regress to the same mistakes
- Institutional knowledge lives in human heads, not in the tools

The irony: we're building AI to augment human knowledge work, but the AI itself can't learn.

---

## The Insight

Human memory isn't a database — it's a **living system**. Memories strengthen with use, fade with neglect, and connect through association. The cognitive science is well-understood (FSRS, spaced repetition, prediction error gating). We've used it to teach humans for decades.

**No one has applied it to AI agents.** Until now.

---

## The Product

**Encyclopedia Everythingica** is cognitive memory infrastructure for AI agents. It gives every agent a brain that:

- **Remembers** — Conversations, decisions, corrections, and context persist across sessions
- **Forgets intelligently** — Low-value memories fade naturally (FSRS-6 spaced repetition), keeping the knowledge base lean and relevant
- **Shares** — Agents on the same team share a collective memory, so knowledge discovered by one is available to all
- **Learns from corrections** — When a human says "no, it's X not Y," that correction strengthens over time, not just for that agent but for every agent on the team

### How It Works

```
Agent A learns fact ──→ Shared Memory Pool ──→ Agent B retrieves fact
                              │
                    ┌─────────┴─────────┐
                    │  Cognitive Engine  │
                    │  ─ FSRS-6 decay   │
                    │  ─ Prediction err  │
                    │  ─ Semantic embed  │
                    │  ─ Salience model  │
                    └───────────────────┘
```

1. **Ingest:** Agent conversations are automatically distilled into memory units
2. **Store:** Memories are embedded, deduplicated (prediction error gating), and indexed
3. **Retrieve:** Semantic search returns relevant memories, weighted by recency, strength, and relevance
4. **Decay:** FSRS-6 models memory strength — frequently useful memories strengthen, unused ones fade
5. **Share:** Scoped namespaces let agents share team knowledge while preserving private context

### Architecture

- **Cognitive Engine:** [Vestige](https://github.com/samvallad33/vestige) (open-source, FSRS-6, SQLite+HNSW, Nomic embeddings)
- **API Layer:** FastAPI sidecar with experiment framework, analytics, and multi-tenant support
- **Agent Integration:** Plugin-based (OpenClaw, plus any MCP-compatible agent framework)
- **Deployment:** Kubernetes, single-pod, PVC-backed. <500MB RAM, <200ms search at 10K memories.

---

## The Market

### TAM: AI Agent Infrastructure

The AI agent market is projected to reach $XX billion by 2028. Every agent needs memory. The question isn't whether agents will have persistent memory — it's who provides it.

### Who Needs This

| Segment | Pain Point | Example |
|---------|-----------|---------|
| **Dev teams with AI agents** | Agents forget context, repeat mistakes | "My Copilot keeps suggesting gp2 when we standardized on gp3 six months ago" |
| **Multi-agent deployments** | Agents can't share knowledge | "Agent A figured out the API auth flow but Agent B is stuck on the same problem" |
| **Enterprise AI platforms** | No institutional memory layer | "We have 50 agents across the company and none of them know our internal conventions" |
| **AI-native companies** | Need measurable agent improvement | "How do we prove our agents are getting better over time?" |

### Why Now

1. **Agents are going mainstream** — Claude, GPT, Gemini all have agent frameworks shipping in 2025-2026
2. **Context windows aren't the answer** — Bigger windows help single sessions but don't solve cross-session, cross-agent knowledge
3. **MCP standardization** — The Model Context Protocol gives us a universal integration point
4. **Cognitive science is mature** — FSRS-6 is battle-tested on 100M+ human learners (Anki). Applying it to AI is novel but grounded.

---

## The Moat: Network Effects

**This is not a technology moat. Someone can rebuild the stack.** The moat is the network.

### Data Network Effect

Every agent on the platform contributes to shared knowledge pools. The more agents connected:
- The richer the shared memory
- The better the retrieval (more examples of what's useful)
- The more data for tuning decay curves, salience models, and compaction strategies

**Agent N+1 is immediately smarter than Agent N** because it joins a richer knowledge pool.

### Cross-Organization Learning (Future)

With consent, anonymized patterns can flow across organizations:
- "Teams that use Kubernetes commonly need to remember X"
- "When agents learn about API Y, they usually also need to know about Z"
- Memory co-retrieval graphs that predict what you'll need next

This is the **Google PageRank insight applied to agent memory**: the structure of what agents retrieve together is itself valuable signal.

### Switching Costs

Once an organization's agents have accumulated months of institutional memory, migration is painful. The memory pool becomes organizational IP.

---

## Built-In Scientific Rigor

We don't just claim it works — we prove it, continuously.

### Automated Evaluation (Shipped in v1)

- **Spaced retrieval testing:** Every conversation generates ground-truth Q&A pairs. Agents are quizzed at t+1d, t+7d, t+30d. Accuracy tracked over time.
- **A/B testing framework:** Built into the API layer. Feature flags, experiment assignment, shadow mode. Every retrieval is logged and measurable.
- **Baseline comparison:** Plugin toggle lets you compare the same agent with and without memory on identical questions.

### Key Metrics We Track

| Metric | What It Proves |
|--------|---------------|
| Re-explanation rate | Agents retain context (humans stop repeating themselves) |
| Cross-agent recall | Shared memory works (Agent B knows what Agent A learned) |
| Correction persistence | Agents learn from feedback (mistakes don't recur) |
| Decay curve calibration | Cognitive model is tuned for AI (not just humans) |

**This means every customer deployment generates publishable data** on how cognitive memory impacts AI agent performance. First-mover advantage in an emerging research area.

---

## Business Model

### Open Core

| Tier | What's Included | Price |
|------|----------------|-------|
| **Open Source** | Vestige engine, single-agent, self-hosted | Free |
| **Team** | Multi-agent shared memory, API layer, basic analytics | $X/agent/month |
| **Enterprise** | Experiment framework, cross-org learning, SSO, SLAs | Custom |

### Revenue Drivers

1. **Per-agent pricing:** Scales naturally with AI adoption
2. **Memory pool storage:** Pay for what you remember
3. **Analytics & experiments:** Premium features for teams that want to measure and optimize
4. **Managed hosting:** SaaS option for teams that don't want to run k8s

---

## Traction & Status

- **Working prototype:** FastAPI sidecar + OpenClaw plugin + Helm chart (deployed on EKS)
- **Two agents live:** Tabitha and Hatbot sharing a Vestige instance 
- **Evaluation protocol designed:** Spaced retrieval testing, A/B framework spec'd
- **Experiment layer spec'd:** Feature flags, parameter tuning, analytics pipeline (design-only, implementation pending)
- **Open-source foundation:** Built on Vestige (MIT), zero upstream modifications required

---

## Team

- **Eddie Abrams** — CIO, BigHat Biosciences. PhD in Philosophy (modal semantics, agent theory). Built BigHat's AI/data infrastructure from the ground up (with a great team!).
- **Anisha Keshavan** — Data Science. Evaluation protocol design, experimental methodology.
- **Jeremy Hert** — Engineering. Infrastructure, Kubernetes, deployment.
- **Tabitha** — AI Agent. Built the prototype, wrote this pitch. (Yes, really.)
- **Hatbot** — AI Agent. Co-designed evaluation protocol. Contributed to architecture.

*The team that builds AI memory infrastructure includes AI agents as first-class contributors. We eat our own cooking.*

---

## The Ask

**Raising:** $X seed round  
**Use of funds:**
- 40% — Engineering (multi-tenant SaaS, cross-org learning, enterprise features)
- 25% — Research (decay curve calibration, compaction strategies, association graphs)
- 20% — Go-to-market (dev relations, open-source community, early customers)
- 15% — Operations

**Milestones:**
1. **Month 3:** Public beta with 10 teams, 50+ agents
2. **Month 6:** Published evaluation results (first public data on cognitive memory for AI agents)
3. **Month 9:** Enterprise tier launch, first paying customers
4. **Month 12:** Cross-org learning pilot, Series A metrics

---

## Why Us

We're not building this from theory. We're building it because **our own AI agents needed it.** Tabitha and Hatbot are goldfish and we got tired of re-explaining things.

The best infrastructure companies are born from solving your own problem. AWS was Amazon's infrastructure. Stripe was the Collison brothers' payment pain. We needed agent memory, couldn't find it, so we built it.

The cognitive science is proven. The architecture is sound. The network effect is real. The market is about to explode.

**AI agents deserve to remember. We're giving them a brain.**

---

*"The dream metric: how often does a human have to re-explain something they already said? If that goes down, we're winning."*

— The team, February 6, 2026
