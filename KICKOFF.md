# KICKOFF.md — running this build in Claude Code

Copy/paste prompts for driving the `prisma-extension-timescaledb` build. Run Claude Code
from the repo root (where `CLAUDE.md` lives).

---

## 1. Initial prompt (first message)

> Read CLAUDE.md, SPEC.md, and BUILD_PLAN.md in full before doing anything.
> docs/research.md has background if you need it.
>
> This project is `prisma-extension-timescaledb`. The whole point is the reset-safety
> constraints in CLAUDE.md — treat those as non-negotiable.
>
> Start with Milestone S — the reset-safety spike in SPIKE.md — using the docker-compose
> database. Prove a hypertable + continuous aggregate survive `prisma migrate reset` run
> twice, with hand-written migrations. Show me the result and stop for review before
> scaffolding the package (Milestone 0). Don't implement anything marked out-of-scope.
>
> Before you write anything, give me a short plan for the spike so I can confirm we agree.

---

## 2. Advancing to the next milestone

After you've reviewed and you're happy:

> Looks good, proceed to Milestone 1. Same rules — implement only this milestone, run the
> gate checks, then stop for review.

---

## 3. Resuming in a fresh session

Claude Code re-reads `CLAUDE.md` automatically on startup but won't remember where you left
off. So in a new session, state the progress:

> We've completed Milestones 0–N. Re-read CLAUDE.md and BUILD_PLAN.md, then continue with
> Milestone N+1 — only that milestone, then stop for review.

---

## 4. Keeping it in scope (use if it drifts)

> That's out of scope for v0.1 per SPEC.md §6 — stay on the current milestone. Vector,
> BM25, hypercore, and retention are explicitly excluded until v0.1 ships.

---

## Operating notes

- **Stop-after-each-milestone is the most important habit.** Without it, the agent will
  run through all milestones in one pass and you lose the review checkpoints the build plan
  is built around. Reinforce it every turn.
- **Milestone 5 needs Docker running locally** (Testcontainers spins up a real TimescaleDB
  for the reset-safety test). Have Docker up *before* that milestone, not before
  Milestone 0. If Docker is unavailable, the suite should skip loudly, not pass silently.
- **The reset-safety guarantee only becomes real at Milestone 5.** Green tests before then
  are progress, not proof — don't treat the reset problem as solved until that integration
  test passes (and passes twice, to prove idempotency).
- **Let the agent scaffold (Milestone 0) rather than hand-merging** into any pre-existing
  stub files. It expects to create `package.json`, `tsconfig`, and the `tsup` setup itself.
- **Watch the generator/runtime coupling.** CLAUDE.md requires the client extension to work
  *without* the generator (manual config path). If the agent tightly couples them to
  "simplify," push back — that decoupling is what protects users from a Prisma DMMF change.
