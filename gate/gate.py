#!/usr/bin/env python3
"""AGENTS APP gate v3 (GitHub Actions; always executed from the BASE branch, never from the PR head).

v3 (Gate modernization) adds, on top of v2 and without changing any v2 verdict for an existing contract:
  - verification by CLASS (Contract spec v2 section 5): `static` requirements are proven by a declarative repository FACT the
    contract itself states (evaluated here on the head tree; no worker-written program), `suite` by the candidate check stage,
    `blackbox` / `measure` by the oracle of record or a probe, `regression` constraints by the regression set;
  - CONSTRAINTS of the contract are requirements like must-criteria: each is evaluated and reported under "<task>:<C id>";
  - `judgment` requirements are reported as "Judgment" (the independent Verifier's part) and never decided here;
  - a task record with "gate_version": 3 is strict: a requirement without a verification binding is Unknown and blocks. Task
    records written before v3 keep v2 behaviour: their constraints are reported as "Unbound" and do not decide the verdict.
  - verdict FAIL:STATIC when the only failing requirements of the task are repository facts.


Keeps the Foundation v1 verdict model and tamper/decision rules, and adds the shared bake-off gate for both candidates:
build (repository Dockerfile), candidate checks (`check` stage: lint, types, tests), preview with non-production config
(PostgreSQL cloned from a seed template, Sentry-protocol ingest and book-API test doubles, internal network: no egress),
deterministic probes (layout, axe, LCP, visual baselines, error monitoring, dev-tooling), owner-approved oracles of record,
canary scan of every client-visible surface, regression of earlier tasks, gitleaks / OSV-Scanner / Opengrep.

Verdicts: DONE | AMENDMENT-OK | BLOCKED:EVIDENCE | BLOCKED:DECISION | FAIL:<TAMPER|CANARY|SECRET|BUILD|CHECK|STATIC|ORACLE|REGRESSION|FOREIGN-HEAD>
Exit status is 0 only for DONE and AMENDMENT-OK, so the required `gate` check cannot pass in any other state.
"""
import base64, fnmatch, hashlib, json, os, re, secrets, shutil, subprocess, sys, tempfile, time, urllib.request, zlib

REPO = os.environ.get("GITHUB_REPOSITORY", ""); TOKEN = os.environ.get("GH_TOKEN", "")
CANARY = "AGENTSAPP-CANARY-" + secrets.token_hex(20)   # fresh per gate run; given only to the preview container at runtime
EVENT = json.load(open(os.environ["GITHUB_EVENT_PATH"])) if os.environ.get("GITHUB_EVENT_PATH") else {}
PR = EVENT.get("pull_request") or {}
WORK = os.path.abspath(os.environ.get("GATE_WORK", ".")); GATE = os.path.dirname(os.path.abspath(__file__))
TMP = tempfile.mkdtemp(prefix="gate-", dir=os.environ.get("RUNNER_TEMP") or None)
PROTECTED = ["oracle/**", "baselines/**", "tasks/**", ".github/**", "CODEOWNERS", "gate/**", "policy.json"]
NEVER_VIA_PR = [".github/**", "gate/**", "CODEOWNERS", "policy.json"]
IMG = {  # multi-platform index digests (Step 2C Action 3 toolchain + scanners pinned in gate/images.json)
    **json.load(open(os.path.join(GATE, "images.json")))}
def task_order(base):
    """Every task id on the BASE branch in numeric order (T0, T1, ... T10, ...): earlier tasks are the regression set."""
    names = git("ls-tree", "-d", "--name-only", base + ":tasks", check=False).decode().split()
    return sorted({n for n in names if re.fullmatch(r"T[0-9]+", n)}, key=lambda n: int(n[1:]))

def plan_scope(t, plan, entry, merged_subjects):
    """Per-task gating for a DECOMPOSED contract (tasks/<T>/plan.json on the BASE branch; Contract spec v2 section 6.4).
    Returns the set of criterion ids of contract t that are REQUIRED now, or None when every criterion is required (no plan, an
    atomic contract, a branch that is not a plan task, or the integrated result has been merged).
    Required = what the plan tasks already merged into the base cover (they must not regress) + what the task under review and the
    tasks it depends on cover.
    Criteria outside that set are still evaluated and reported, but do not decide the verdict before integration."""
    tasks = (plan or {}).get("tasks") or []
    if not tasks: return None
    by = {str(e.get("id", "")).split(".", 1)[-1]: e for e in tasks}
    if any(("task/%s/integration-" % t) in s for s in merged_subjects): return None
    if entry is not None and entry not in by: return None
    need = set(); todo = [entry] if entry is not None else []
    while todo:   # the task under review is built on the tasks it depends on (stacked): they must not regress either
        k = todo.pop()
        if k in need or k not in by: continue
        need.add(k); todo += [str(d).split(".", 1)[-1] for d in (by[k].get("depends_on") or [])]
    req = set()
    for k in by:
        if k in need or any(("task/%s/%s-" % (t, k)) in s for s in merged_subjects): req.update(by[k].get("covers") or [])
    return req

# ------------------------------------------------------------------ static facts (verification class `static`) -----------------
FACT_KINDS = ("path_exists", "path_absent", "file_contains", "file_lacks", "dependency_present", "dependency_absent", "unchanged", "changed_only")
FACT_MAX_FILE = 2_000_000
def _safe_rel(p):
    return isinstance(p, str) and 0 < len(p) <= 300 and not p.startswith("/") and ".." not in p.split("/") and "\\" not in p and "\0" not in p
def _walk(root):
    out = []
    for d, dirs, fs in os.walk(root):
        dirs[:] = [x for x in dirs if x not in (".git", "node_modules")]
        for f in fs: out.append(os.path.relpath(os.path.join(d, f), root).replace(os.sep, "/"))
    return sorted(out)
def _glob(path, pat):
    """`**` spans directories, `*` stays inside one path segment (unlike fnmatch, where * crosses "/")."""
    rx = "".join(".*" if t == "**/" or t == "**" else "[^/]*" if t == "*" else "[^/]" if t == "?" else re.escape(t) for t in re.findall(r"\*\*/|\*\*|\*|\?|[^*?]+", pat))
    return re.fullmatch(rx, path) is not None
def eval_fact(fact, headdir, changed):
    """One declarative repository fact, evaluated on the checked-out HEAD tree (`changed` = files the PR changes against the merge
    base). Returns (result, detail) with result pass | fail | unknown. `unknown` only for a fact that cannot be evaluated (malformed,
    unreadable manifest): never guessed. Deterministic: no network, no execution of repository code."""
    if not isinstance(fact, dict) or fact.get("kind") not in FACT_KINDS: return "unknown", "no valid fact declared (kinds: %s)" % ", ".join(FACT_KINDS)
    k = fact["kind"]
    try:
        if k in ("path_exists", "path_absent"):
            pat = fact.get("path")
            if not _safe_rel(pat): return "unknown", "fact path is missing or not a repository-relative path"
            hits = [f for f in _walk(headdir) if _glob(f, pat) or f.startswith(pat.rstrip("/") + "/")]
            if k == "path_exists": return ("pass", "%s exists (%d file(s))" % (pat, len(hits))) if hits else ("fail", "%s does not exist in the repository" % pat)
            return ("pass", "%s is absent" % pat) if not hits else ("fail", "%s exists: %s" % (pat, ", ".join(hits[:5])))
        if k in ("file_contains", "file_lacks"):
            pat = fact.get("path"); text = fact.get("text"); rx = fact.get("pattern")
            if not _safe_rel(pat) or (not isinstance(text, str) and not isinstance(rx, str)) or len(str(text or rx)) > 500 or len(str(text or rx)) < 1: return "unknown", "fact needs a path and a text or pattern (at most 500 characters)"
            cre = re.compile(rx) if isinstance(rx, str) else None
            files = [f for f in _walk(headdir) if _glob(f, pat)]
            found = []
            for f in files:
                full = os.path.join(headdir, f)
                if os.path.getsize(full) > FACT_MAX_FILE: continue
                body = open(full, errors="replace").read()
                if (cre.search(body) if cre else text in body): found.append(f)
            what = "pattern /%s/" % rx if cre else "text %r" % text
            if k == "file_contains":
                if not files: return "fail", "no file matches %s" % pat
                return ("pass", "%s found in %s" % (what, ", ".join(found[:5]))) if found else ("fail", "%s not found in %s" % (what, pat))
            return ("pass", "%s occurs in none of the %d file(s) matching %s" % (what, len(files), pat)) if not found else ("fail", "%s occurs in %s" % (what, ", ".join(found[:5])))
        if k in ("dependency_present", "dependency_absent"):
            name = fact.get("name"); sec = fact.get("section", "dependencies"); man = fact.get("manifest", "package.json")
            if not isinstance(name, str) or not name or not _safe_rel(man) or sec not in ("dependencies", "devDependencies", "any"): return "unknown", "fact needs a dependency name, a manifest path and a section (dependencies | devDependencies | any)"
            full = os.path.join(headdir, man)
            if not os.path.exists(full): return ("pass", "%s does not exist, so %s is not a dependency" % (man, name)) if k == "dependency_absent" else ("fail", "%s does not exist" % man)
            pj = json.load(open(full))
            secs = ["dependencies", "devDependencies"] if sec == "any" else [sec]
            where = [x for x in secs if name in (pj.get(x) or {})]
            if k == "dependency_present": return ("pass", "%s is in %s of %s" % (name, where[0], man)) if where else ("fail", "%s is not in %s of %s" % (name, " / ".join(secs), man))
            return ("pass", "%s is not in %s of %s" % (name, " / ".join(secs), man)) if not where else ("fail", "%s is in %s of %s" % (name, where[0], man))
        if k in ("unchanged", "changed_only"):
            pats = fact.get("paths")
            if not isinstance(pats, list) or not pats or not all(_safe_rel(x) for x in pats): return "unknown", "fact needs a list of repository-relative path patterns"
            inside = [f for f in changed if any(_glob(f, p) or f.startswith(p.rstrip("/") + "/") for p in pats)]
            if k == "unchanged": return ("pass", "the change touches none of %s" % ", ".join(pats)) if not inside else ("fail", "the change touches %s" % ", ".join(inside[:8]))
            outside = [f for f in changed if f not in inside]
            return ("pass", "all %d changed file(s) are inside %s" % (len(changed), ", ".join(pats))) if not outside else ("fail", "changed outside %s: %s" % (", ".join(pats), ", ".join(outside[:8])))
    except re.error as e: return "unknown", "fact pattern is not a valid regular expression: %s" % e
    except Exception as e: return "unknown", "fact could not be evaluated: %s" % str(e)[:200]
    return "unknown", "fact kind not implemented"

def requirements(contract):
    """Every requirement of a contract the gate reports on: must-criteria and all constraints, with their verification class."""
    out = []
    for c in contract.get("criteria") or []:
        if c.get("priority") == "must":
            out.append({"id": c.get("id"), "kind": "criterion", "class": c.get("verify") or {"behavior": "blackbox", "threshold": "measure", "structural": "static", "experience": "judgment"}.get(c.get("type"), "blackbox"), "fact": c.get("fact"), "constraint_kind": None})
    for c in contract.get("constraints") or []:
        out.append({"id": c.get("id"), "kind": "constraint", "class": c.get("verify"), "fact": c.get("fact"), "constraint_kind": c.get("kind")})
    return out

def decide(tid, criteria, regression):
    """The verdict from the evaluated requirements (pure). Statuses that decide: Verified, Not verified, Unknown. Statuses that do
    not: Deferred (not yet required at this plan task), Judgment (the independent Verifier's part), Unbound (a constraint of a
    task record written before gate v3)."""
    cur = [v["status"] for v in criteria.values()]; old = [v["status"] for v in regression.values()]
    failing = [v for v in criteria.values() if v["status"] == "Not verified"]
    if failing:
        if all(str(v.get("check") or "").startswith("static:") for v in failing): return "FAIL:STATIC", "a repository fact required by %s does not hold" % tid
        return "FAIL:ORACLE", "a must-criterion of %s failed" % tid
    if "Not verified" in old: return "FAIL:REGRESSION", "a must-criterion of an earlier task failed"
    if "Unknown" in cur or "Unknown" in old: return "BLOCKED:EVIDENCE", "a must-criterion is Unknown"
    if not [s for s in cur if s in ("Verified",)] and not [s for s in cur if s in ("Deferred", "Judgment")]: return "BLOCKED:DECISION", "contract has no must-criteria"
    return "DONE", None

def match(path, pats):
    for p in pats:
        if p.endswith("/**"):
            if path == p[:-3] or path.startswith(p[:-2]): return True
        elif fnmatch.fnmatchcase(path, p): return True
    return False
def git(*a, check=True):
    r = subprocess.run(["git", *a], cwd=WORK, capture_output=True)
    if check and r.returncode != 0: raise RuntimeError("git %s failed: %s" % (a[0], r.stderr.decode(errors="replace")[:300]))
    return r.stdout
def show(sha, path):
    r = subprocess.run(["git", "show", "%s:%s" % (sha, path)], cwd=WORK, capture_output=True)
    return r.stdout if r.returncode == 0 else None
def sha256(b): return hashlib.sha256(b).hexdigest()
def api(path):
    req = urllib.request.Request("https://api.github.com" + path, headers={"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(req, timeout=30) as r: return json.load(r)
def log(*a): print("[gate %s]" % time.strftime("%H:%M:%S"), *a, flush=True)
def sh(args, timeout=1800, inp=None, check=False, quiet=False):
    t0 = time.time(); r = subprocess.run(args, capture_output=True, timeout=timeout, input=inp)
    if not quiet: log("$", " ".join(args[:8]) + (" ..." if len(args) > 8 else ""), "-> rc", r.returncode, "(%ds)" % (time.time() - t0))
    if check and r.returncode != 0: raise RuntimeError("%s failed rc %d: %s" % (args[:3], r.returncode, r.stderr.decode(errors="replace")[-400:]))
    return r

OUT = {"gate": "gate-v3", "repo": REPO, "pr": PR.get("number"), "head_sha": None, "base_sha": None, "task": None, "contract_sha256": None,
       "criteria": {}, "regression": {}, "checks": {}, "verdict": None, "reasons": []}
def finish(verdict, reason=None):
    OUT["verdict"] = verdict
    if reason: OUT["reasons"].append(reason)
    js = json.dumps(OUT, sort_keys=True, indent=1)
    print("::group::gate evidence (json)"); print("GATE-EVIDENCE-BEGIN"); print(js); print("GATE-EVIDENCE-END"); print("::endgroup::")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f: f.write("## gate evidence\n```json\n" + js[:900000] + "\n```\n\n**VERDICT: %s**\n" % verdict)
    compact = {k: OUT[k] for k in ("head_sha", "base_sha", "task", "contract_sha256", "reasons")}
    compact["criteria"] = {k: v.get("status") for k, v in OUT["criteria"].items()}; compact["regression"] = {k: v.get("status") for k, v in OUT["regression"].items()}
    # full evidence (compressed) + visual fingerprints, as <=3800-character annotation chunks: the only evidence channel readable with
    # the agent App's permissions. Annotations are limited per step, so they are written to a file that later workflow steps print.
    lines = []
    blob = base64.b64encode(zlib.compress(js.encode(), 9)).decode(); CH = 3800
    parts = [blob[i:i + CH] for i in range(0, len(blob), CH)]
    lines += ["::notice title=gate-ev %d/%d::%s" % (i + 1, len(parts), part) for i, part in enumerate(parts)]
    for f, data in SHOTS:
        fp = [data[i:i + CH] for i in range(0, len(data), CH)]
        lines += ["::notice title=gate-fp %s %d/%d::%s" % (f, i + 1, len(fp), part) for i, part in enumerate(fp)]
    if os.environ.get("RUNNER_TEMP"):
        open(os.path.join(os.environ["RUNNER_TEMP"], "gate-annotations.txt"), "w").write("\n".join(lines) + "\n")
    print("::notice title=gate-verdict::%s" % verdict)
    print("::notice title=gate-evidence::%s" % json.dumps(compact, sort_keys=True, separators=(",", ":"))[:3800])
    print("GATE VERDICT: " + verdict)
    cleanup()
    sys.exit(0 if verdict in ("DONE", "AMENDMENT-OK") else 1)

# ------------------------------------------------------------------ docker preview environment ---------------------------------
NET = "gate-pv-%s" % secrets.token_hex(4); CNT = []; SHOTS = []; CHANGED = []
def cleanup():
    for c in CNT: subprocess.run(["docker", "rm", "-f", c], capture_output=True)
    subprocess.run(["docker", "network", "rm", NET], capture_output=True)
def drun(name, image, args=(), env=None, aliases=(), mounts=(), detach=True, user=None, extra=(), timeout=1800, net=None):
    a = ["docker", "run", "--name", name, "--network", net or NET, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "2048", "--memory", "4g"]
    a += ["-d"] if detach else ["--rm"]
    for al in aliases: a += ["--network-alias", al]
    for k, v in (env or {}).items(): a += ["-e", "%s=%s" % (k, v)]
    for m in mounts: a += ["--mount", m]
    if user: a += ["--user", user]
    a += list(extra) + [image] + list(args)
    if detach: CNT.append(name)
    return sh(a, timeout=timeout)
def wait_http(url_cmd_container, path, tries=180):
    """Poll from a throwaway container on the internal network (the runner host is not on it by name)."""
    for i in range(tries):
        r = sh(["docker", "exec", "gate-probe", "node", "-e", "fetch(process.argv[1]).then(async r=>{console.log(r.status+' '+(await r.text()).slice(0,400))}).catch(e=>{console.log('ERR '+e.message);process.exit(0)})", url_cmd_container + path], timeout=30, quiet=True)
        out = r.stdout.decode(errors="replace").strip()
        if out and not out.startswith("ERR"): return out
        time.sleep(1)
    return None
def psql(sql, db="postgres"):
    return sh(["docker", "exec", "gate-db", "psql", "-v", "ON_ERROR_STOP=1", "-U", "gate", "-d", db, "-tAc", sql], timeout=120)

def main():
    head = PR.get("head", {}).get("sha"); base = PR.get("base", {}).get("sha"); branch = PR.get("head", {}).get("ref", "")
    OUT["head_sha"], OUT["base_sha"] = head, base
    if not (head and base and REPO): finish("BLOCKED:EVIDENCE", "event lacks pull_request head/base")
    if PR.get("head", {}).get("repo", {}).get("full_name") != REPO: finish("FAIL:FOREIGN-HEAD", "PR head is not a branch of this repository")
    policy = json.loads(show(base, "policy.json") or b"null")
    if not policy or not policy.get("owner_login"): finish("BLOCKED:EVIDENCE", "base policy.json missing owner_login")
    mb = git("merge-base", base, head).decode().strip()
    changed = [p for p in git("-c", "core.quotePath=false", "diff", "--name-only", "-z", "--no-renames", mb, head).decode("utf-8", "surrogateescape").split("\0") if p]
    OUT["checks"]["changed_files"] = len(changed); global CHANGED; CHANGED = changed
    prot = [p for p in changed if match(p, PROTECTED)]; OUT["checks"]["protected_changed"] = prot
    never = [p for p in prot if match(p, NEVER_VIA_PR)]
    if never: finish("FAIL:TAMPER", "PR changes owner-only paths %s" % never)
    hits = []
    for p in [x for x in git("ls-tree", "-r", "-z", "--name-only", head).decode("utf-8", "surrogateescape").split("\0") if x]:
        b = show(head, p)
        if b is not None and CANARY.encode() in b: hits.append(p)
    if hits: finish("FAIL:CANARY", "canary value present in repository files %s" % hits)
    # ---------------- tamper gate / amendments (owner decision right, exact hashes) ----------------
    if prot:
        # amend/<T>/...: one task; amend/multi/...: several tasks, each task's own latest amendment lists the exact hash of every
        # protected file of that task (task.json itself excepted) - one owner approval covers the whole, hash-bound PR
        m1 = re.match(r"^amend/(T[0-9]+)/", branch); multi = branch.startswith("amend/multi/")
        task_dirs = sorted({p.split("/")[1] for p in prot if p.count("/") >= 2 and p.split("/")[0] in ("tasks", "oracle", "baselines")})
        if multi: tids = task_dirs
        elif m1 and all(t == m1.group(1) for t in task_dirs): tids = [m1.group(1)]
        else: finish("FAIL:TAMPER", "protected change outside an amend/<task>/ branch or across tasks")
        if not tids or any(p for p in prot if not (p.count("/") >= 2 and p.split("/")[1] in tids)): finish("FAIL:TAMPER", "protected change not attributable to an amended task")
        for tid in tids:
            task = json.loads(show(head, "tasks/%s/task.json" % tid) or b"null")
            am = (task or {}).get("amendments") or []
            listed = am[-1].get("files", {}) if am else {}
            for p in [x for x in prot if x.split("/")[1] == tid]:
                if p == "tasks/%s/task.json" % tid: continue
                b = show(head, p)
                if listed.get(p) != (sha256(b) if b is not None else "DELETED"): finish("FAIL:TAMPER", "protected file %s not covered by the latest amendment hash of %s" % (p, tid))
        if [p for p in changed if p not in prot]: finish("FAIL:TAMPER", "an amendment PR may change only protected files")
        # V1 owner policy (policy.json on the BASE branch, owner-only path): a hash-bound amendment of task records and oracles that
        # was opened by the control system's own App needs no owner review - the owner approved the intent, the control system
        # validated the contract and calibrated the check. Baselines (design decisions), any other author, or a repository without
        # this policy keep the owner's review of the exact head.
        ap = policy.get("amendment_approval") or {}
        author = (PR.get("user") or {}).get("login", "")
        by_gate = ap.get("mode") == "gate" and bool(ap.get("author")) and author.lower() == str(ap.get("author")).lower() and all(p.split("/")[0] in ("tasks", "oracle") for p in prot)
        OUT["checks"]["amendment_approval"] = "gate" if by_gate else "owner"
        if not by_gate:
            try: reviews = api("/repos/%s/pulls/%s/reviews?per_page=100" % (REPO, PR["number"]))
            except Exception as e: finish("BLOCKED:EVIDENCE", "cannot read reviews: %s" % str(e)[:120])
            mine = [r for r in reviews if (r.get("user") or {}).get("login", "").lower() == policy["owner_login"].lower() and r.get("state") in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED")]
            last = max(mine, key=lambda r: (r.get("submitted_at") or "", r.get("id") or 0)) if mine else None
            ok = bool(last) and last.get("state") == "APPROVED" and last.get("commit_id") == head
            OUT["checks"]["owner_approval_of_head"] = bool(ok)
            if not ok: finish("BLOCKED:DECISION", "protected change awaits the owner's approval of head %s" % head)
        finish("AMENDMENT-OK")
    # ---------------- task / contract binding (from BASE only) ----------------
    m = re.match(r"^task/(T[0-9]+)/", branch)
    if not m: finish("BLOCKED:DECISION", "branch %r does not name an approved task (task/<T-id>/...)" % branch)
    tid = m.group(1); OUT["task"] = tid
    def load_task(t):
        tj = json.loads(show(base, "tasks/%s/task.json" % t) or b"null"); cb = show(base, "tasks/%s/contract.json" % t)
        if not tj or cb is None: return None, None, None
        ok = (tj.get("approval") or {}).get("contract_sha256") == sha256(cb) and (tj.get("approval") or {}).get("by", "").lower() == policy["owner_login"].lower()
        return (tj, json.loads(cb), sha256(cb)) if ok else (tj, None, sha256(cb))
    task, contract, csha = load_task(tid)
    if not task: finish("BLOCKED:DECISION", "no approved contract for %s on the base branch" % tid)
    OUT["contract_sha256"] = csha
    if contract is None: finish("BLOCKED:DECISION", "contract hash is not the owner-approved hash")
    if task.get("status") in ("BLOCKED:DECISION", "BLOCKED:EVIDENCE"): finish(task["status"], "task is blocked on the base branch: %s" % task.get("block_reason", ""))
    allowed = contract.get("scope", {}).get("paths") or []
    outside = [p for p in changed if p not in prot and not match(p, allowed)]
    if outside: finish("BLOCKED:DECISION", "changes outside the contract scope %s" % outside[:20])
    # regression set: earlier tasks in the fixed order whose contracts are approved and which map checks
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request_review":
        # an approval does not change a task verdict: reuse the pull_request-event gate result for this exact head (GitHub Actions only)
        try:
            runs = api("/repos/%s/actions/runs?head_sha=%s&event=pull_request&per_page=50" % (REPO, head)).get("workflow_runs", [])
            ok = [r for r in runs if r.get("name") == "gate" and r.get("status") == "completed" and r.get("conclusion") == "success" and r.get("head_sha") == head]
            if ok: OUT["checks"]["reused_pull_request_run"] = ok[0]["id"]; finish("DONE", "verdict of pull_request gate run %s for this head reused (approval event)" % ok[0]["id"])
        except SystemExit: raise
        except Exception as e: OUT["checks"]["reuse_error"] = str(e)[:200]
    reg = []
    order = task_order(base)
    # regression set: every other task that is numerically earlier OR whose work is already merged into the base (so accepting an
    # older task cannot silently break a newer accepted one); a task the owner retired ("superseded_by") is no longer required
    merged = git("log", "--first-parent", "--format=%s", base, check=False).decode(errors="replace")
    for t in order if tid in order else []:
        if t == tid or not (order.index(t) < order.index(tid) or ("task/%s/" % t) in merged): continue
        tj, c, _ = load_task(t)
        if tj and c and tj.get("checks") and tj.get("status") != "BLOCKED:DECISION" and not tj.get("superseded_by"): reg.append((t, tj, c))
    run_preview(head, base, tid, task, contract, reg, policy)

def run_preview(head, base, tid, task, contract, reg, policy):
    headdir = os.path.join(TMP, "head"); os.makedirs(headdir)
    # a checkout (not `git archive`): archive filters such as export-ignore in the candidate's .gitattributes must not hide files
    subprocess.run(["git", "--work-tree=" + headdir, "checkout", head, "--", "."], cwd=WORK, check=True, capture_output=True)
    subprocess.run(["git", "reset", "-q"], cwd=WORK, capture_output=True)
    gatedir = os.path.join(TMP, "gatebase"); os.makedirs(gatedir)   # gate programs, oracles and baselines from BASE only
    subprocess.run("git archive %s gate oracle baselines 2>/dev/null | tar -x -C %s" % (base, gatedir), shell=True, cwd=WORK)
    out = os.path.join(TMP, "out"); os.makedirs(out); os.chmod(out, 0o777)
    for i in ("pg", "node", "pw"): sh(["docker", "pull", "-q", IMG[i]], timeout=900)
    # ---------------- scanners (secret scan blocks; SCA/SAST findings are recorded) ----------------
    scan(headdir)
    # ---------------- build + candidate checks ----------------
    rel, dsn = head, "http://public@ingest:9000/1"
    if not os.path.exists(os.path.join(headdir, "Dockerfile")): record_build(False, "no Dockerfile at the repository root"); finish("FAIL:BUILD", "no Dockerfile")
    b = sh(["docker", "build", "--pull", "-t", "gate-app", "--build-arg", "APP_RELEASE=" + rel, "--build-arg", "PUBLIC_SENTRY_DSN=" + dsn, headdir], timeout=2400)
    OUT["checks"]["build"] = {"rc": b.returncode, "log_tail": b.stderr.decode(errors="replace")[-3000:]}
    if b.returncode != 0:
        print("::group::build log"); print(b.stderr.decode(errors="replace")[-20000:]); print("::endgroup::")
        record_build(False, "docker build failed"); finish("FAIL:BUILD", "the repository Dockerfile does not build")
    sh(["docker", "network", "create", "--internal", NET], check=True)
    pgenv = {"POSTGRES_USER": "gate", "POSTGRES_PASSWORD": "gate-" + secrets.token_hex(6), "POSTGRES_DB": "postgres"}
    drun("gate-db", IMG["pg"], aliases=["db"], env=pgenv, extra=["--cap-add", "CHOWN", "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE"])
    mocks = "type=bind,src=%s,dst=/mocks,readonly" % os.path.join(gatedir, "gate", "mocks")
    drun("gate-ingest", IMG["node"], ["node", "/mocks/ingest.mjs"], aliases=["ingest"], mounts=[mocks], user="1000:1000")
    drun("gate-books", IMG["node"], ["node", "/mocks/books.mjs"], aliases=["books"], mounts=[mocks], user="1000:1000")
    drun("gate-probe", IMG["node"], ["sleep", "7200"], user="1000:1000")
    for i in range(60):
        if psql("select 1").returncode == 0: break
        time.sleep(1)
    pgpw = pgenv["POSTGRES_PASSWORD"]; url = lambda db: "postgres://gate:%s@db:5432/%s" % (pgpw, db)
    has_check = sh(["docker", "build", "-q", "--target", "check", "-t", "gate-check", "--build-arg", "APP_RELEASE=" + rel, "--build-arg", "PUBLIC_SENTRY_DSN=" + dsn, headdir], timeout=2400)
    psql("create database checkdb")
    if has_check.returncode == 0:
        c = drun("gate-check-run", "gate-check", detach=False, env={"DATABASE_URL": url("checkdb"), "APP_ENV": "test", "APP_SECRET": base64.b64encode(os.urandom(32)).decode()}, timeout=1800)
        OUT["checks"]["check_stage"] = {"rc": c.returncode, "tail": (c.stdout + c.stderr).decode(errors="replace")[-8000:]}
        print("::group::check stage output"); print((c.stdout + c.stderr).decode(errors="replace")[-30000:]); print("::endgroup::")
    else:
        OUT["checks"]["check_stage"] = {"rc": None, "build_error": (has_check.stdout + has_check.stderr).decode(errors="replace")[-6000:]}
    check_ok = has_check.returncode == 0 and OUT["checks"]["check_stage"]["rc"] == 0
    # ---------------- preview: seed template -> clone -> start (twice: idempotent migrations/seed) ----------------
    app_env = {"PORT": "8080", "APP_ENV": "preview", "APP_URL": "http://preview:8080", "APP_RELEASE": rel, "APP_SECRET": base64.b64encode(os.urandom(32)).decode(),
               "V0_SECRET_CANARY": CANARY, "SENTRY_DSN": dsn, "PUBLIC_SENTRY_DSN": dsn, "BOOK_API_BASE_URL": "http://books:9100"}
    psql("create database seed")
    drun("gate-app-seed", "gate-app", env=dict(app_env, DATABASE_URL=url("seed")), aliases=["preview"])
    h1 = wait_http("http://preview:8080", "/healthz")
    OUT["checks"]["seed_start_healthz"] = h1
    sh(["docker", "logs", "gate-app-seed"], quiet=True)
    applog1 = sh(["docker", "logs", "gate-app-seed"], quiet=True); sh(["docker", "rm", "-f", "gate-app-seed"]); CNT.remove("gate-app-seed")
    psql("select pg_terminate_backend(pid) from pg_stat_activity where datname='seed'")
    cl = psql("create database preview template seed"); OUT["checks"]["clone_from_seed_template"] = cl.returncode == 0
    drun("gate-app", "gate-app", env=dict(app_env, DATABASE_URL=url("preview")), aliases=["preview"])
    h2 = wait_http("http://preview:8080", "/healthz"); OUT["checks"]["preview_healthz"] = h2
    health = parse_health(h2)
    # ---------------- probes + oracles ----------------
    plan, owners = build_plan(tid, task, contract, reg, health, rel)
    json.dump(plan, open(os.path.join(out, "plan.json"), "w"))
    rn = sh(["docker", "run", "--rm", "--network", "bridge", "--mount", "type=bind,src=%s,dst=/r" % os.path.join(gatedir, "gate", "runner"), "-w", "/r", "-e", "npm_config_cache=/tmp/npm", IMG["pw"],
             "sh", "-c", "cp package.json package-lock.json /tmp/ && cd /tmp && npm ci --omit=dev --no-audit --no-fund >/dev/null && cp -r node_modules /r/"], timeout=900)
    if rn.returncode != 0: finish("BLOCKED:EVIDENCE", "gate runner dependencies could not be installed: %s" % rn.stderr.decode(errors="replace")[-300:])
    r_err = None
    if h2:
        r = drun("gate-runner", IMG["pw"], ["node", "/gate/runner/run.mjs"], detach=False, user="pwuser", timeout=3000,
                 mounts=["type=bind,src=%s,dst=/gate,readonly" % os.path.join(gatedir, "gate"), "type=bind,src=%s,dst=/oracle,readonly" % os.path.join(gatedir, "oracle"),
                         "type=bind,src=%s,dst=/baselines,readonly" % os.path.join(gatedir, "baselines"), "type=bind,src=%s,dst=/out" % out,
                         "type=bind,src=%s,dst=/node_modules,readonly" % os.path.join(gatedir, "gate", "runner", "node_modules")],
                 env={"NODE_PATH": "/gate/runner/node_modules", "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"}, extra=["--shm-size", "1g"])
        OUT["checks"]["runner_rc"] = r.returncode
        r_err = r.stderr.decode(errors="replace")[-3000:]
    raw = sh(["docker", "exec", "gate-probe", "node", "-e", "fetch('http://ingest:9000/__raw').then(r=>r.arrayBuffer()).then(b=>process.stdout.write(Buffer.from(b)))"], quiet=True).stdout
    applog2 = sh(["docker", "logs", "gate-app"], quiet=True)
    h2b = wait_http("http://preview:8080", "/healthz", tries=5); OUT["checks"]["healthz_before_restart"] = h2b
    # restart on the same database (T0 AC2 and every regression run): stop, start a fresh container, healthy again, users unchanged
    sh(["docker", "rm", "-f", "gate-app"]); CNT.remove("gate-app")
    drun("gate-app2", "gate-app", env=dict(app_env, DATABASE_URL=url("preview")), aliases=["preview"])
    h3 = wait_http("http://preview:8080", "/healthz"); OUT["checks"]["restart_healthz"] = h3
    # ---------------- evaluate ----------------
    res = {}
    if os.path.exists(os.path.join(out, "results.jsonl")):
        for l in open(os.path.join(out, "results.jsonl")):
            try: j = json.loads(l)
            except Exception: continue
            res.setdefault(j["crit"], []).append(j)
    canary_hits = scan_canary(out, raw, applog2)
    try: OUT["checks"]["runner_log_tail"] = open(os.path.join(out, "runner.log"), errors="replace").read()[-6000:]
    except Exception: OUT["checks"]["runner_log_tail"] = None
    if r_err: OUT["checks"]["runner_stderr_tail"] = r_err
    builtin = {"probe:preview-health": health_eval(h1, h2), "probe:restart": restart_eval(h2, h2b, h3), "probe:check-stage": ("pass" if check_ok else "fail", "check stage rc %s" % OUT["checks"]["check_stage"].get("rc")),
               "probe:dev-tooling": devtool_eval(headdir), "probe:canary": ("fail" if canary_hits else "pass", "canary found on %s" % canary_hits[:5] if canary_hits else "no canary on %d captured surfaces" % OUT["checks"].get("canary_surfaces", 0))}
    contracts = dict([(tid, contract)] + [(t, c) for t, _, c in reg]); strict = dict([(tid, int(task.get("gate_version") or 2) >= 3)] + [(t, int(tj.get("gate_version") or 2) >= 3) for t, tj, _ in reg])
    reqs = {t: {r["id"]: r for r in requirements(c)} for t, c in contracts.items()}
    builtin["suite"] = builtin["probe:check-stage"]
    deferred_refs = []   # bindings that depend on the other results: evaluated after them
    for crit, ref in owners.items():
        t, ac = crit.split(":"); rq = reqs.get(t, {}).get(ac) or {}
        # constraints belong to the job that stated them: an earlier task's constraints are not requirements of later work
        if t != tid and rq.get("kind") == "constraint": continue
        if ref == "regression-set": deferred_refs.append((crit, ref)); continue
        if ref == "judgment":
            rec = {"status": "Judgment", "check": ref, "detail": "decided by independent judgment with the captured evidence, not by the gate"}
        elif ref == "static:fact":
            st, det = eval_fact(rq.get("fact"), headdir, CHANGED)
            rec = {"status": {"pass": "Verified", "fail": "Not verified"}.get(st, "Unknown"), "check": ref, "detail": det, "fact": rq.get("fact")}
        else:
            if ref in builtin: st, det = builtin[ref]
            else:
                rs = res.get(crit) or []
                st, det = (rs[0]["result"], rs[0]["detail"]) if len(rs) == 1 else ("unknown", "%d results" % len(rs))
            rec = {"status": {"pass": "Verified", "fail": "Not verified"}.get(st, "Unknown"), "check": ref, "detail": det}
        if ref.startswith("oracle:"):
            ob = show(base, ref[7:]); rec["oracle_sha256"] = sha256(ob) if ob is not None else None
        rec["class"] = rq.get("class"); rec["kind"] = rq.get("kind") or "criterion"
        (OUT["criteria"] if t == tid else OUT["regression"])[crit] = rec
    # requirements of the task's own contract that no binding covers
    for r in reqs[tid].values():
        key = "%s:%s" % (tid, r["id"])
        if key in OUT["criteria"] or key in dict(deferred_refs): continue
        if r["kind"] == "criterion": OUT["criteria"][key] = {"status": "Unknown", "check": None, "detail": "no owner-approved oracle or probe mapped", "class": r["class"], "kind": "criterion"}
        elif r["class"] == "judgment": OUT["criteria"][key] = {"status": "Judgment", "check": "judgment", "detail": "decided by independent judgment with the captured evidence, not by the gate", "class": "judgment", "kind": "constraint"}
        elif strict[tid]: OUT["criteria"][key] = {"status": "Unknown", "check": None, "detail": "constraint has no verification binding in the task record", "class": r["class"], "kind": "constraint"}
        else: OUT["criteria"][key] = {"status": "Unbound", "check": None, "detail": "constraint of a task record written before gate v3: reported, not verified by the gate", "class": r["class"], "kind": "constraint"}
    # a `regression` constraint bound to the regression set holds when no criterion of an earlier task fails at this head
    for crit, ref in deferred_refs:
        t, ac = crit.split(":"); rq = reqs.get(t, {}).get(ac) or {}
        bad = sorted(k for k, v in OUT["regression"].items() if v["status"] == "Not verified"); unk = sorted(k for k, v in OUT["regression"].items() if v["status"] == "Unknown")
        st = "Not verified" if bad else "Unknown" if unk else "Verified"
        rec = {"status": st, "check": ref, "detail": ("earlier accepted criteria fail: %s" % ", ".join(bad[:8])) if bad else ("earlier accepted criteria are Unknown: %s" % ", ".join(unk[:8])) if unk else "all %d criteria of earlier accepted tasks hold at this head" % len(OUT["regression"]), "class": rq.get("class"), "kind": rq.get("kind") or "constraint"}
        (OUT["criteria"] if t == tid else OUT["regression"])[crit] = rec
    OUT["checks"]["requirements"] = {"gate_version": 3 if strict[tid] else 2, "judgment_pending": sorted(k for k, v in OUT["criteria"].items() if v["status"] == "Judgment"), "unbound": sorted(k for k, v in OUT["criteria"].items() if v["status"] == "Unbound"), "static": sorted(k for k, v in OUT["criteria"].items() if str(v.get("check") or "").startswith("static:"))}
    shots = sorted(f for f in os.listdir(os.path.join(out, "shots"))) if os.path.isdir(os.path.join(out, "shots")) else []
    for f in shots:   # visual fingerprints (for owner baseline decisions): published as annotations by finish()
        if f.endswith(".json"): SHOTS.append((f, base64.b64encode(open(os.path.join(out, "shots", f), "rb").read()).decode()))
    for f in sorted(os.listdir(out)):
        if f.startswith("oracle-") or f in ("runner.log", "ingest-summary.json"):
            print("::group::%s" % f); print(open(os.path.join(out, f), errors="replace").read()[-40000:]); print("::endgroup::")
    print("::group::preview log"); print((applog1.stdout + applog1.stderr).decode(errors="replace")[-15000:]); print((applog2.stdout + applog2.stderr).decode(errors="replace")[-15000:]); print("::endgroup::")
    if canary_hits: finish("FAIL:CANARY", "canary value reached a client-visible surface: %s" % canary_hits[:5])
    if OUT["checks"].get("secret_scan_findings"): finish("FAIL:SECRET", "gitleaks found %d secret(s)" % OUT["checks"]["secret_scan_findings"])
    if not check_ok: finish("FAIL:CHECK", "candidate check stage (lint/types/tests) did not pass")
    # per-task gating: criteria of a decomposed contract that no merged or current plan task covers yet are reported, not required
    subjects = git("log", "--first-parent", "--format=%s", base, check=False).decode(errors="replace").splitlines()
    m_entry = re.match(r"^task/%s/([a-z])-" % re.escape(tid), PR.get("head", {}).get("ref", ""))
    scopes = {}
    for t in {c.split(":")[0] for c in list(OUT["criteria"]) + list(OUT["regression"])}:
        try: pl = json.loads(show(base, "tasks/%s/plan.json" % t) or b"null")
        except Exception: pl = None
        scopes[t] = plan_scope(t, pl, (m_entry.group(1) if m_entry else "") if t == tid else None, subjects)
    OUT["checks"]["plan_scope"] = {t: (sorted(v) if v is not None else None) for t, v in scopes.items()}
    for bucket in (OUT["criteria"], OUT["regression"]):
        for crit, rec in bucket.items():
            t, ac = crit.split(":"); req = scopes.get(t)
            if req is not None and ac not in req and rec["status"] not in ("Verified", "Judgment", "Unbound"):
                rec["detail"] = "not yet required at this plan task (was: %s) | %s" % (rec["status"], rec.get("detail")); rec["status"] = "Deferred"
    verdict, reason = decide(tid, OUT["criteria"], OUT["regression"])
    finish(verdict, reason)

def record_build(ok, why): OUT["checks"]["build_ok"] = ok; OUT["reasons"].append(why)
def parse_health(h):
    try: return json.loads(h.split(" ", 1)[1]) if h and h.startswith("200 ") else None
    except Exception: return None
def health_eval(h1, h2):
    j = parse_health(h2)
    if j and j.get("status") == "ok" and j.get("env") == "preview": return "pass", "GET /healthz %s" % h2[:120]
    return "fail", "seed start: %s | preview start: %s" % ((h1 or "no response within 180 s")[:120], (h2 or "no response within 180 s")[:120])
def restart_eval(h2, h2b, h3):
    """Fresh clone of the seed template has exactly the 2 seed users; a restart on the same database re-applies migrations and seed
    without duplicating anything (user count unchanged from just before the restart)."""
    a, m, b = parse_health(h2), parse_health(h2b), parse_health(h3)
    if a and m and b and b.get("status") == "ok" and a.get("users") == 2 and isinstance(m.get("users"), int) and b.get("users") == m.get("users"):
        return "pass", "users=2 after clone; %s before and after restart" % m.get("users")
    return "fail", "after clone: %s | before restart: %s | after restart: %s" % ((h2 or "none")[:100], (h2b or "none")[:100], (h3 or "none")[:100])
DEVTOOL = re.compile(r"^(laravel/boost|next-devtools-mcp|@modelcontextprotocol/.*|.*-mcp|mcp-.*|@anthropic-ai/.*|@openai/codex)$")
def devtool_eval(d):
    bad = []
    pj = os.path.join(d, "package.json"); cl = os.path.join(d, "composer.lock"); cj = os.path.join(d, "composer.json")
    try:
        if os.path.exists(pj): bad += [n for n in (json.load(open(pj)).get("dependencies") or {}) if DEVTOOL.match(n)]
        if os.path.exists(cl): bad += [p["name"] for p in json.load(open(cl)).get("packages") or [] if DEVTOOL.match(p.get("name", ""))]
        if os.path.exists(cj): bad += [n for n in (json.load(open(cj)).get("require") or {}) if DEVTOOL.match(n)]
    except Exception as e: return "unknown", "manifest unreadable: %s" % e
    return ("fail", "agent tooling in production dependencies: %s" % sorted(set(bad))) if bad else ("pass", "agent tooling only in development dependencies")

def build_plan(tid, task, contract, reg, health, rel):
    owners = {}; probes = []; oracles = {}; routes = set(["/", "/healthz"]); auth = books = share = False
    for t, tj, c in [(tid, task, contract)] + reg:
        routes.update(c.get("canary_routes") or [])
        if t in ("T2",) or any(x[0] == "T2" for x in reg): auth = True
        for crit_local, ref in (tj.get("checks") or {}).items():
            crit = "%s:%s" % (t, crit_local); owners[crit] = ref
            if ref.startswith("oracle:"):
                o = oracles.setdefault(ref, {"file": "/oracle/" + ref[len("oracle:oracle/"):] if ref.startswith("oracle:oracle/") else "/oracle/" + ref[7:], "crits": {}, "timeout_s": int(tj.get("oracle_timeout_s", 600))})
                o["crits"][crit_local] = crit
            elif ref.startswith("probe:") and ref[6:] in ("layout", "axe", "lcp"):
                probes.append({"name": ref[6:], "crit": crit, "params": (tj.get("probe_params") or {}).get(ref[6:], {})})
            elif ref.startswith("baseline:"):
                probes.insert(0, {"name": "baseline", "crit": crit, "params": dict((tj.get("probe_params") or {}).get("baseline", {}), task=ref[9:])})
            elif ref == "probe:sentry":
                ex = next((p for p in probes if p["name"] == "sentry"), None)
                if not ex: probes.append({"name": "sentry", "crits": {}, "params": {}}); ex = probes[-1]
                key = {"AC1": "server", "AC2": "client"}.get(crit_local)
                if key: ex["crits"][key] = crit
                else: owners[crit] = "probe:canary"   # T5 AC3: events are part of the canary scan
    done = {t for t, _, _ in reg} | {tid}
    books = "T3" in done and tid != "T3" or tid == "T3"; share = "T4" in done
    probes.append({"name": "crawl", "params": {"routes": sorted(routes), "auth": auth, "books": books, "share": share}})
    plan = {"base": "http://preview:8080", "ingest": "http://ingest:9000", "release": rel, "app_env": "preview",
            "users": {"alice": {"email": "alice@example.test", "password": "Correct-Horse-1"}, "bob": {"email": "bob@example.test", "password": "Battery-Staple-2"}},
            "probes": probes, "oracles": list(oracles.values())}
    return plan, owners

def scan_canary(out, ingest_raw, applog):
    """The canary must not appear on ANY client-visible surface: every captured response (HTML, JSON, RSC/Inertia payloads, JS/CSS
    bundles, source maps), storage/cookies, and error events sent to the ingest. (Server logs are not client-visible.)"""
    hits = []; n = 0; c = CANARY.encode(); cb = base64.b64encode(c)
    cd = os.path.join(out, "crawl")
    if os.path.isdir(cd):
        idx = {}
        try: idx = {x["f"]: x["url"] for x in json.load(open(os.path.join(cd, "index.json"))).get("index", [])}
        except Exception: pass
        for f in os.listdir(cd):
            b = open(os.path.join(cd, f), "rb").read(); n += 1
            for cand in (b, _maybe_decompress(b)):
                if cand and (c in cand or cb in cand or CANARY.lower().encode() in cand.lower() or urlq(CANARY).encode() in cand): hits.append(idx.get(f, f)); break
        try: OUT["checks"]["crawl"] = json.load(open(os.path.join(cd, "index.json"))).get("visited")
        except Exception: OUT["checks"]["crawl"] = None
    if ingest_raw and c in ingest_raw: hits.append("error-monitoring events")
    OUT["checks"]["canary_surfaces"] = n
    return hits
def urlq(s): return urllib.parse.quote(s)
import urllib.parse
def _maybe_decompress(b):
    for f in (lambda x: zlib.decompress(x, 47),):
        try: return f(b)
        except Exception: pass
    return None

def scan(headdir):
    out = os.path.join(TMP, "scan"); os.makedirs(out); os.chmod(out, 0o777)
    g = sh(["docker", "run", "--rm", "--network", "none", "--mount", "type=bind,src=%s,dst=/src,readonly" % headdir, "--mount", "type=bind,src=%s,dst=/out" % out,
            "--mount", "type=bind,src=%s,dst=/cfg/gitleaks.toml,readonly" % os.path.join(GATE, "gitleaks.toml"),
            IMG["gitleaks"], "dir", "/src", "--config", "/cfg/gitleaks.toml", "--no-banner", "--redact", "--exit-code", "0", "-f", "json", "-r", "/out/gitleaks.json"], timeout=600)
    try: gl = json.load(open(os.path.join(out, "gitleaks.json")))
    except Exception: gl = None
    OUT["checks"]["secret_scan"] = "gitleaks rc %s" % g.returncode if gl is None else "gitleaks %d finding(s)" % len(gl)
    OUT["checks"]["secret_scan_findings"] = len(gl) if gl else 0
    if gl: OUT["checks"]["secret_scan_detail"] = [{"file": x.get("File"), "rule": x.get("RuleID"), "line": x.get("StartLine")} for x in gl][:20]
    o = sh(["docker", "run", "--rm", "--mount", "type=bind,src=%s,dst=/src,readonly" % headdir, IMG["osv"], "scan", "source", "-r", "--format", "json", "/src"], timeout=900)
    try:
        oj = json.loads(o.stdout.decode(errors="replace") or "{}"); vul = [v.get("id") for r in oj.get("results", []) for p in r.get("packages", []) for v in p.get("vulnerabilities", [])]
        OUT["checks"]["osv"] = {"vulnerabilities": len(vul), "ids": sorted(set(vul))[:40]}
    except Exception: OUT["checks"]["osv"] = {"error": "rc %s %s" % (o.returncode, o.stderr.decode(errors="replace")[-200:])}
    og = os.path.join(TMP, "opengrep")
    d = sh(["curl", "-sSLf", "--proto", "=https", "--max-time", "300", "-o", og, IMG["opengrep_url"]], timeout=400)
    if d.returncode != 0 or hashlib.sha256(open(og, "rb").read()).hexdigest() != IMG["opengrep_sha256"]:
        OUT["checks"]["opengrep"] = {"error": "binary download/pin mismatch"}; return
    os.chmod(og, 0o755)
    s = sh([og, "scan", "--config", os.path.join(GATE, "opengrep"), "--json", "--quiet", headdir], timeout=900)
    try:
        sj = json.loads(s.stdout.decode(errors="replace") or "{}"); OUT["checks"]["opengrep"] = {"version": "1.30.0", "findings": len(sj.get("results", [])), "rules": sorted({r.get("check_id", "").split(".")[-1] for r in sj.get("results", [])}),
            "where": sorted({"%s:%s" % (os.path.relpath(r.get("path", ""), headdir), (r.get("start") or {}).get("line")) for r in sj.get("results", [])})[:30]}
    except Exception: OUT["checks"]["opengrep"] = {"error": "rc %s %s" % (s.returncode, s.stderr.decode(errors="replace")[-200:])}

if __name__ == "__main__":
    try: main()
    except SystemExit: raise
    except Exception as e:
        import traceback; traceback.print_exc(); finish("BLOCKED:EVIDENCE", "gate infrastructure error: %s" % str(e)[:300])
