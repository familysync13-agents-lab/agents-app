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

## Evidence

Evidence lives in one table (`evidence`) and is written only through the evidence store (`src/worker/evidence.ts`; rules in
`src/domain/evidence.ts`). Everything below is deterministic software; no model collects, links, seals or judges evidence.

- **Structure and criterion linkage.** Every row has a kind (criterion, regression, finding, verifier run, attribution, oracle
  calibration / validation / mutation, regression oracle) and, where it applies, the task and criterion id it belongs to. Linkage is
  by id, never by matching text. A finding the Verifier did not tie to a criterion stays unlinked.
- **Provenance.** Collector (gate, verifier, builder, control plane, owner), the worker run or gate result behind the row, the check
  that produced it, the contract version, and the plan task or integrated result the judged head belongs to.
- **Integrity.** A hash chain per task over the canonical row, including the hash of the artifact it points to. An edited, removed,
  inserted or reordered row, or a changed artifact body, is detected. Rows from before this phase are sealed as `backfilled`.
- **Status.** The status of a criterion is computed (Verified, Partially verified, Not verified, Unknown, Waived): only evidence bound
  to the judged head and the approved contract version counts; the latest observation decides; agent judgment alone never satisfies
  a must-criterion; a blocking independent finding against a verified criterion makes it Partially verified.
- **Packages.** For every judged head an evidence package is assembled and stored (`evidence_packages`, body as an artifact): one per
  plan task on the criteria in its scope, one for an atomic task, one for the integrated result against the whole contract. It names
  gaps and inconsistencies and carries a handoff section for Gate, Verifier (criterion ids and evidence requirements only) and Decision.
- **Enforcement.** A passing gate verdict that the package of the same head does not carry, or evidence that fails its integrity
  check, blocks the task. DONE and the acceptance decision cite the final package and its hash.

Operator checks (`src/admin/cli.ts`): `evidence_audit` (integrity of every task), `evidence_package` (package of a head),
`evidence_replay` (every recorded gate verdict against the package of its head).

Local-model roles on evidence (`src/domain/evidence-roles.ts`) are qualified separately from every Builder class and are evaluation
only until approved: `finding_association` (link an unlinked Verifier finding to the criterion it reports as violated, or to none).

## Gate (v3)

The gate (`gate/gate.py`, owner-only path, run from the base branch) judges every requirement of a contract by its verification
class (Contract spec v2 section 5). The task record binds each must-criterion and constraint to what proves it
(`gateBindings` in `src/domain/contract.ts`):

| Class | Proven by | Binding |
|---|---|---|
| `blackbox`, `measure` | the check of record written blind by the Verifier, or a probe | `oracle:...`, `probe:...` |
| `static` | a declarative repository fact the requirement itself states (`fact`) | `static:fact` |
| `suite` | the candidate check stage (type check, lint, tests) | `suite` |
| `regression` constraint | the checks of earlier accepted tasks | `regression-set` |
| `judgment` | independent judgment with captured evidence; reported by the gate, never decided by it | `judgment` |

- Facts are declarative (`path_exists`, `path_absent`, `file_contains`, `file_lacks`, `dependency_present`, `dependency_absent`,
  `unchanged`, `changed_only`), validated by lint and evaluated on the head tree. No worker-written program is involved.
- Constraints are requirements: each is reported as `<task>:<C id>` and counted in the evidence package when the gate judged it.
- A task record with `gate_version: 3` is strict: a requirement without a binding is Unknown and blocks. Older task records keep
  their v2 behaviour; their constraints are reported as Unbound.
- A failed repository fact gives `FAIL:STATIC` and goes straight back to the Builder (no arbiter: a fact has no check to be wrong).
- A structural must-criterion is allowed with a fact. An experience must stays disabled until the Verifier phase.
- Scanner results (secrets, dependencies, static analysis) are evidence rows. Secrets fail the gate; the other two are recorded.

Tests: `python3 gate/tests/test_gate.py` (the gate's own rules) and `tests/gate.test.ts`.

## Verifier

The independent Verifier (a different vendor, blind to the code and to the Builder's narrative) checks a preview of the exact head
after the gate passed and the evidence package of that head is complete. Its result is structured and its consequences are
computed (`src/domain/verification.ts`), never taken from its wording:

- **Coverage** by id: one verdict (conforms / violated / not checked) per must-criterion and observable constraint.
- **Judgment** with captured evidence for requirements whose proof is judgment (experience criteria, judgment-class constraints).
  A judgment-class constraint is decided by it; a judgment without evidence is "cannot judge".
- **Findings** tied to a criterion id (or none), with a class: only `implementation` is the Builder's; `check`, `infrastructure`,
  `evidence` and `control_plane` are recorded as failures of the verification and never sent to the Builder.
- **Materiality**: a finding sends the work back only when it is an implementation defect, critical or high, against a
  requirement of the contract, a regression or a security defect.
- **False-positive control**: for material findings the Verifier writes a reproduction script and the control plane runs it itself
  against the same preview. Reproduced: the work goes back. Ran and did not reproduce: the finding is recorded as unconfirmed and
  does not go back. No working script: the finding keeps its effect, so a missing script cannot hide a defect.
- **Precedence**: the Verifier never overrides a gate failure or an evidence-integrity failure; its "conforms" is shown beside a
  criterion's status and cannot change it.
- **Handoff**: the assessment is stored as an artifact (`verifier-report`) tied to head, run and contract version; the final
  evidence package carries coverage, findings by disposition, judgments and - when the Verifier could not verify - the class of
  that failure. Calibration figures: operator check `verifier_calibration`.

## Development

```
npm ci
npm run check            # typecheck + lint + tests (PGlite: real PostgreSQL semantics, no server)
DATABASE_URL=pglite://.data/dev npm run migrate
DATABASE_URL=pglite://.data/dev npm run dev
```

The control loop is tested end to end with a scripted executor (`tests/orchestrator.test.ts`): contract drafting, oracle authoring, owner approval, contract PR, gate failure → automatic correction, independent Verifier findings → correction, DONE, acceptance, decision-required paths, harness failures, and the correction budget.
