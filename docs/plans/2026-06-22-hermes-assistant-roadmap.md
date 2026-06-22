# Roadmap: Hermes assistant + content pipeline

**Date:** 2026-06-22
**Status:** living roadmap (sequencing + intent)
**Org:** `platform-infrastructure` (Forgejo `forgejo.seyzahl.com`), cluster `tachtit`
**Related:** Phase 2 pipeline spec `docs/specs/2026-06-22-hermes-n8n-email-pipeline-design.md`; Hermes app `apps/base/hermes-agent`.

## The vision (Pedro, 2026-06-22)

A family/household assistant that grows into a personal life-OS, plus a *separate
but related* content pipeline — each tool used for what it's best at:

- **Hermes** (API tokens, cheap, always-on) — watch, draft, propose, confirm.
- **Subscription Claude / claude-code desktop** (flat-rate) — the heavy creative writing.
- **PAI** (local) — media generation + publishing.
- **n8n** — plumbing / event bus / pre-processing (the trust boundary).
- **Forgejo** — task queue (tickets/issues) + audit/ground truth.

The cost-split is the point: don't burn API tokens on long-form generation.

## Track A — the assistant loop

Recommended order — *prove the simple loop in daily use before adding plumbing.*

1. **DONE** — calendar (CalDAV MCP → Nextcloud **Family**, `#103`/`#104`), email
   gateway (dedicated inbox, `#98`), voice STT (`#7`/`#102`), SOUL.md persona +
   timezone (`#106`). Models: default Sonnet, `/model`→Opus on demand.
2. **NEXT — voice → confirmed calendar/email (daily-use MVP).** Voice memo in
   Telegram → Hermes drafts a calendar event or email → **confirms before acting**.
   - Confirm-before-acting is **already live** via SOUL.md draft-confirm (the agent
     asks in text, you reply yes/no). Functionally satisfies "it confirms first."
   - **Inline tap-Yes/No buttons are NOT a Hermes config knob.** Hermes' button
     approval (`tools/approval.py`) gates *dangerous shell commands*, the model
     picker, and `/update` — not MCP writes like calendar `create-event`. Real
     buttons need either (a) an upstream Hermes feature, or (b) the n8n path
     (Track A.4 / Phase 2), where n8n owns the Telegram inline keyboard. Until
     then, text-confirm is the safety.
3. **Phase 2 — n8n email watcher.** n8n watches the inbox, runs the trust-boundary
   pipeline (filter → tool-less extractor → schema gate → Hermes drafts), and
   **reports to Telegram with next-step actions**. See the pipeline spec.
   - Note: today email-in → email-out (the gateway replies by email). "Hermes
     reports to me on Telegram about my email" is *this* step, not built yet.
4. **Phase 2+ — n8n as event listener.** Calendar/email events → create events or
   report with action steps. This is where **inline confirm buttons live cleanly**
   (n8n constructs the Telegram keyboard, waits for the tap, then writes).

## Track B — content pipeline (SEPARATE, parallel; gated on prerequisites)

Hermes spots infra changes → drafts a Forgejo ticket → claude-code desktop writes
the post in Pedro's voice (from his writing corpus) → PAI does images + publish →
weekly Substack aggregation.

- **B1** — Hermes queries `platform-infrastructure/` diffs, judges *candidate
  angles* (not every diff is blog-worthy), writes a ticket/issue in `pedrotchang/blog`
  for the desktop claude-code client to grab; the ticket becomes the post spec +
  prompt/template referencing Pedro's writing examples ("secondbrain") for tone.
- **B2** — runs through PAI locally: generate images, assemble the post, publish.
- **B3** — weekly: aggregate the week's posts into a longer Substack article.

### Track B caveats (decided 2026-06-22)
1. **The corpus is the real prerequisite.** Tone-matching is only as good as the
   examples in secondbrain — "I need to write more" (Pedro). Growing + tagging
   voice exemplars is human work and is step zero. No pipeline fixes a thin corpus.
2. **Human review gate before publish.** Do NOT auto-publish AI-as-Pedro (B2/B3).
   Same draft-confirm principle, applied to content — protects the authenticity the
   corpus exists to preserve. Gate stays until the voice is provably his.
3. **Topic curation.** Hermes proposes candidate angles; a human (or a bar) picks —
   avoid a firehose of posts about trivial commits.

## Open / deferred
- Inline confirm buttons for the Hermes-direct flow (upstream feature vs accept n8n-path buttons).
- "Ari investment tracker" semantics (unclear; doesn't block anything).
- Observability — see `[[llm-observability-backlog]]` (memory): LLM-obs proxy at the Headroom hop.
