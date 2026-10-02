# Agents App — V0 control plane

The control system of Architecture Baseline v0.1: it holds the owner's approved intent and decides, from evidence bound to exact commits, whether work done by replaceable AI workers is **done, blocked or rejected**. Workers sit outside it.

```
OWNER INTENT → CONTRACT (drafted by a worker, lint-checked, oracle written blind, owner-approved on GitHub)
  → WORK (Builder, isolated container) → EVIDENCE (structured outcome files, gate evidence per SHA)
  → ENFORCEMENT (the repository gate, required check) → INDEPENDENT VERIFICATION (Verifier, different vendor, blind)
  → CORRECTION (automatic, budgeted) → DECISION (owner only when needed) → ACCEPTED (owner approval on GitHub + merge)
```

## Components

| Piece | Where | Trust |
|---|---|---|
| Web UI (Next.js 16, React 19, Tailwind 4) | container `agents-app-web`, published on **127.0.0.1:3700 only** | owner session from a one-time link minted by the host daemon; no credentials |
| Control loop (`src/worker`) | container `agents-app-worker`, internal network only | deterministic code, no credentials, no network except the database |
| PostgreSQL 18 (Drizzle schema + migrations) | container `agents-app-db`, internal network, persistent volume | password kept host-side (`~/.agents-app/app-db.pw`) |
| Executor | the owner-launched, hash-bound host daemon (`bakeoff/kit/bko.py`) | claims `executor_jobs` rows, validates every op against an allowlist, executes with the Foundation v1 mechanisms (custodian → transport token ≤1 h per repo, role gateways, hardened containers, credential volumes) |

The app never holds a GitHub token, the App key, or a Claude/Codex credential. Its only path to execution is the `executor_jobs` table.

## State model

- Lifecycle (`src/domain/lifecycle.ts`): PROPOSED → CONTRACTED → IN_PROGRESS → VERIFYING → DONE → ACCEPTED, with BLOCKED_DECISION / BLOCKED_EVIDENCE, REJECTED, ABANDONED. Every transition is written with the mechanical fact that caused it (`transitions.fact`).
- Authoritative intent (contract, task record, oracle) lives in the project repository; the database is the operational record (runs, jobs, gate results, typed evidence, decisions, activity).
- A worker's closing chat message is stored for debugging only and never used for state: only `.bakeoff/REPORT.md`, `.bakeoff/BLOCKED.json` and `.bakeoff/contract.json` count.
- DONE requires a passing gate result for the exact PR head bound to the approved contract hash; evidence statuses are Verified / Partially verified / Not verified / Unknown / Waived — Unknown is never upgraded.

## Development

```
npm ci
npm run check            # typecheck + lint + tests (PGlite: real PostgreSQL semantics, no server)
DATABASE_URL=pglite://.data/dev npm run migrate
DATABASE_URL=pglite://.data/dev npm run dev
```

The control loop is tested end to end with a scripted executor (`tests/orchestrator.test.ts`): contract drafting, oracle authoring, owner approval, contract PR, gate failure → automatic correction, independent Verifier findings → correction, DONE, acceptance, decision-required paths, harness failures, and the correction budget.
