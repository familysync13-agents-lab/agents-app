#!/usr/bin/env python3
"""Unit tests of the gate's pure rules (gate v3): repository facts, requirement enumeration, plan scope and the verdict.
Run: python3 gate/tests/test_gate.py   (no network, no Docker; the gate's main() is not executed)."""
import importlib.util, json, os, sys, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("gate", os.path.join(HERE, "..", "gate.py")); gate = importlib.util.module_from_spec(spec); spec.loader.exec_module(gate)

def tree(files):
    d = tempfile.mkdtemp(prefix="gate-test-")
    for p, body in files.items():
        full = os.path.join(d, p); os.makedirs(os.path.dirname(full), exist_ok=True); f = open(full, "w"); f.write(body); f.close()
    return d

class Facts(unittest.TestCase):
    def setUp(self):
        self.d = tree({"package.json": json.dumps({"dependencies": {"next": "16"}, "devDependencies": {"vitest": "5", "next-devtools-mcp": "1"}}), "src/db/schema.ts": "export const a = 1;\n", "src/app/page.tsx": "<h1>Command</h1>\n",
                       "drizzle/0001_init.sql": "create table t();\n", "src/db/preview-demo.ts": "if (process.env.APP_ENV !== 'preview') throw new Error('demo data is preview-only');\n"})
    def f(self, fact, changed=()): return gate.eval_fact(fact, self.d, list(changed))
    def test_paths(self):
        self.assertEqual(self.f({"kind": "path_exists", "path": "src/app/page.tsx"})[0], "pass")
        self.assertEqual(self.f({"kind": "path_exists", "path": "src/app/missing.tsx"})[0], "fail")
        self.assertEqual(self.f({"kind": "path_exists", "path": "drizzle/*.sql"})[0], "pass")
        self.assertEqual(self.f({"kind": "path_absent", "path": "drizzle/0002_*.sql"})[0], "pass")
        self.assertEqual(self.f({"kind": "path_absent", "path": "drizzle"}), ("fail", "drizzle exists: drizzle/0001_init.sql"))
        self.assertEqual(self.f({"kind": "path_absent", "path": "src/*.ts"})[0], "pass")           # * does not cross a directory
        self.assertEqual(self.f({"kind": "path_absent", "path": "src/**/*.ts"})[0], "fail")
    def test_content(self):
        self.assertEqual(self.f({"kind": "file_contains", "path": "src/db/preview-demo.ts", "text": "APP_ENV !== 'preview'"})[0], "pass")
        self.assertEqual(self.f({"kind": "file_contains", "path": "src/db/preview-demo.ts", "pattern": r"APP_ENV\s*!==\s*'preview'"})[0], "pass")
        self.assertEqual(self.f({"kind": "file_contains", "path": "src/nope.ts", "text": "x"}), ("fail", "no file matches src/nope.ts"))
        self.assertEqual(self.f({"kind": "file_lacks", "path": "src/**/*.tsx", "text": "dangerouslySetInnerHTML"})[0], "pass")
        self.assertEqual(self.f({"kind": "file_lacks", "path": "src/**/*.tsx", "text": "<h1>"})[0], "fail")
    def test_dependencies(self):
        self.assertEqual(self.f({"kind": "dependency_absent", "name": "next-devtools-mcp"})[0], "pass")                     # production set
        self.assertEqual(self.f({"kind": "dependency_absent", "name": "next-devtools-mcp", "section": "any"})[0], "fail")
        self.assertEqual(self.f({"kind": "dependency_present", "name": "vitest", "section": "devDependencies"})[0], "pass")
        self.assertEqual(self.f({"kind": "dependency_absent", "name": "left-pad", "manifest": "web/package.json"})[0], "pass")
        self.assertEqual(self.f({"kind": "dependency_present", "name": "next", "manifest": "web/package.json"})[0], "fail")
    def test_change_relative(self):
        ch = ["src/app/page.tsx", "tests/page.test.ts"]
        self.assertEqual(self.f({"kind": "unchanged", "paths": ["src/db/**", "drizzle/**"]}, ch)[0], "pass")
        self.assertEqual(self.f({"kind": "unchanged", "paths": ["src/app/**"]}, ch), ("fail", "the change touches src/app/page.tsx"))
        self.assertEqual(self.f({"kind": "changed_only", "paths": ["src/app/**", "tests/**"]}, ch)[0], "pass")
        self.assertEqual(self.f({"kind": "changed_only", "paths": ["src/app/**"]}, ch), ("fail", "changed outside src/app/**: tests/page.test.ts"))
    def test_never_guessed(self):
        for bad in (None, {}, {"kind": "shell", "cmd": "true"}, {"kind": "path_exists"}, {"kind": "path_exists", "path": "../etc/passwd"}, {"kind": "path_exists", "path": "/etc/passwd"},
                    {"kind": "file_contains", "path": "a"}, {"kind": "file_contains", "path": "src/**", "pattern": "("}, {"kind": "dependency_absent"}, {"kind": "unchanged", "paths": []}, {"kind": "unchanged", "paths": ["../x"]}):
            self.assertEqual(self.f(bad)[0], "unknown", bad)
        open(os.path.join(self.d, "package.json"), "w").write("{not json")
        self.assertEqual(self.f({"kind": "dependency_present", "name": "next"})[0], "unknown")

V = lambda s, check="oracle:oracle/T9/check.mjs": {"status": s, "check": check}
class Verdict(unittest.TestCase):
    def test_v2_verdicts_are_unchanged(self):
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Verified")}, {})[0], "DONE")
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Not verified")}, {}), ("FAIL:ORACLE", "a must-criterion of T9 failed"))
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Verified")}, {"T4:AC1": V("Not verified")})[0], "FAIL:REGRESSION")
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Unknown")}, {})[0], "BLOCKED:EVIDENCE")
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Verified")}, {"T4:AC1": V("Unknown")})[0], "BLOCKED:EVIDENCE")
        self.assertEqual(gate.decide("T9", {}, {})[0], "BLOCKED:DECISION")
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Verified"), "T9:AC3": V("Deferred")}, {})[0], "DONE")       # plan task: later criteria not yet required
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Not verified"), "T9:AC2": V("Unknown")}, {"T4:AC1": V("Not verified")})[0], "FAIL:ORACLE")
    def test_v3(self):
        st = "static:fact"
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Verified"), "T9:C2": V("Not verified", st)}, {}), ("FAIL:STATIC", "a repository fact required by T9 does not hold"))
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Not verified"), "T9:C2": V("Not verified", st)}, {})[0], "FAIL:ORACLE")   # behaviour failures lead
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Verified"), "T9:C2": V("Unknown", None)}, {})[0], "BLOCKED:EVIDENCE")       # strict: unbound requirement
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Verified"), "T9:C2": V("Unbound", None), "T9:C3": V("Judgment", "judgment")}, {})[0], "DONE")
        self.assertEqual(gate.decide("T9", {"T9:C1": V("Unbound", None)}, {})[0], "BLOCKED:DECISION")                               # nothing the gate can decide on
        self.assertEqual(gate.decide("T9", {"T9:AC1": V("Verified"), "T9:C1": V("Not verified", "regression-set")}, {})[0], "FAIL:ORACLE")

class Requirements(unittest.TestCase):
    def test_enumeration(self):
        c = {"criteria": [{"id": "AC1", "type": "behavior", "priority": "must", "verify": "blackbox"}, {"id": "AC2", "type": "structural", "priority": "must", "verify": "static", "fact": {"kind": "path_exists", "path": "x"}},
                          {"id": "AC3", "type": "experience", "priority": "should"}, {"id": "AC4", "type": "threshold", "priority": "must"}],
             "constraints": [{"id": "C1", "kind": "regression", "verify": "blackbox"}, {"id": "C2", "kind": "prohibited", "verify": "static", "fact": {"kind": "unchanged", "paths": ["drizzle/**"]}}, {"id": "C3", "kind": "prohibited", "verify": "judgment"}]}
        r = {x["id"]: (x["kind"], x["class"], x["constraint_kind"]) for x in gate.requirements(c)}
        self.assertEqual(r, {"AC1": ("criterion", "blackbox", None), "AC2": ("criterion", "static", None), "AC4": ("criterion", "measure", None), "C1": ("constraint", "blackbox", "regression"), "C2": ("constraint", "static", "prohibited"), "C3": ("constraint", "judgment", "prohibited")})
        self.assertEqual(gate.requirements({"criteria": [{"id": "AC1", "type": "behavior", "priority": "must"}]}), [{"id": "AC1", "kind": "criterion", "class": "blackbox", "fact": None, "constraint_kind": None}])   # a V1 contract

class PlanScope(unittest.TestCase):
    def test_constraints_are_scoped_by_id_like_criteria(self):
        plan = {"tasks": [{"id": "T9.a", "covers": ["AC1", "C2"]}, {"id": "T9.b", "covers": ["AC2"], "depends_on": ["T9.a"]}]}
        self.assertEqual(gate.plan_scope("T9", plan, "a", []), {"AC1", "C2"})
        self.assertEqual(gate.plan_scope("T9", plan, "b", []), {"AC1", "C2", "AC2"})
        self.assertIsNone(gate.plan_scope("T9", plan, "", []) if False else gate.plan_scope("T9", {"tasks": []}, "a", []))

if __name__ == "__main__": unittest.main(verbosity=1)
