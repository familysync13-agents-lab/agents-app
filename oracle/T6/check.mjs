import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3', 'AC6', 'AC7', 'AC8', 'AC10', 'AC11', 'AC12'];
const RUNS = 'Recent worker runs';
const ROUTING = 'Routing and qualification';
const classes = ['contract_draft', 'plan', 'build', 'correction', 'mutants', 'check_author', 'acceptance_check', 'attribution', 'failure_triage', 'log_summary'];
const alternatives = new Set(['build', 'correction', 'failure_triage', 'log_summary']);
const verifier = new Set(['check_author', 'acceptance_check', 'attribution', 'failure_triage']);
const reason = (hasAlternative) => hasAlternative
  ? 'trusted worker (no alternative has qualified for this class)'
  : 'trusted worker (no alternative is defined for this class)';
const norm = (s) => s.replace(/\s+/gu, ' ').trim();
let browser;
let base;
let setupError;
try {
  base = new URL(process.argv[2]);
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (error) {
  setupError = `HARNESS: browser/dependency/baseURL setup failed: ${error.message}`;
}
const url = (path) => new URL(path, base).href;
async function visible(locator) {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
}
async function eventually(check) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try { return await check(); } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}
async function heading(page, name) {
  const h = page.getByRole('heading', { name, exact: true, level: 2 });
  await visible(h);
  assert.equal(await h.count(), 1, `Expected exactly one h2 ${name}`);
  assert.equal((await h.innerText()).trim(), name);
  return h;
}
async function section(page, name) {
  const h = await heading(page, name);
  // The interface promises a card but no tag/class. Find its smallest table-bearing ancestor.
  const card = h.locator('xpath=ancestor::*[descendant::table][1]');
  await visible(card);
  assert.equal(await card.locator('h2').count(), 1, `${name}: could not isolate its own section`);
  return card;
}
async function table(page, name) {
  const card = await section(page, name);
  const t = card.getByRole('table');
  await visible(t);
  assert.equal(await t.count(), 1, `${name}: expected one table`);
  return t;
}
async function rows(page, name) {
  const t = await table(page, name);
  return t.locator('tbody > tr');
}
async function cells(row, count) {
  const c = row.getByRole('cell');
  assert.equal(await c.count(), count, 'Unexpected cell count');
  const values = [];
  for (let i = 0; i < count; i++) {
    await visible(c.nth(i));
    values.push(norm(await c.nth(i).innerText()));
  }
  return values;
}
async function namedRow(page, name, key) {
  const all = await rows(page, name);
  const matches = [];
  for (let i = 0; i < await all.count(); i++) {
    const row = all.nth(i);
    if (norm(await row.getByRole('cell').first().innerText()) === key) matches.push(row);
  }
  assert.equal(matches.length, 1, `Expected one ${name} row for ${key}`);
  return matches[0];
}
async function headers(page, name, expected) {
  const t = await table(page, name);
  const h = t.getByRole('columnheader');
  assert.equal(await h.count(), expected.length);
  const actual = [];
  for (let i = 0; i < expected.length; i++) {
    await visible(h.nth(i));
    actual.push(norm(await h.nth(i).innerText()));
  }
  assert.deepEqual(actual, expected);
}
async function openSystem(page) {
  const response = await page.goto(url('/system'), { waitUntil: 'domcontentloaded' });
  assert.ok(response, '/system returned no document response');
  assert.equal(response.status(), 200, '/system HTTP status');
  assert.equal(new URL(page.url()).pathname, '/system');
  return response;
}
const checks = {
  AC1: async (page) => {
    await openSystem(page);
    await eventually(() => headers(page, RUNS, ['Task', 'Purpose', 'Worker', 'Task class', 'Reason', 'Context bytes']));
  },
  AC2: async (page) => {
    await openSystem(page);
    await eventually(async () => {
      const r = await rows(page, RUNS);
      assert.equal(await r.count(), 2);
      const expected = [ ['T3', 'build', 'claude-code', 'build', reason(true)], ['T1', 'draft_contract', 'claude-code', 'contract_draft', reason(false)] ];
      for (let i = 0; i < expected.length; i++) {
        const actual = await cells(r.nth(i), 6);
        for (const j of [0, 2, 3, 4]) assert.equal(actual[j], expected[i][j], `Run ${i + 1}, field ${j + 1}`);
        assert.ok(actual[1] === expected[i][1] || new RegExp(`^${expected[i][1]}(?:\\s|[(:—–-])`).test(actual[1]), `Purpose must start with ${expected[i][1]}`);
      }
    });
  },
  AC3: async (page) => {
    await openSystem(page);
    await eventually(async () => {
      const build = await cells(await namedRow(page, RUNS, 'T3'), 6);
      const draft = await cells(await namedRow(page, RUNS, 'T1'), 6);
      assert.equal(build[5].replace(/(?:bytes|B)\s*$/u, '').replace(/[,\s]/gu, ''), '48213');
      assert.equal(draft[5], '—');
    });
  },
  AC6: async (page) => {
    await openSystem(page);
    await eventually(async () => {
      await headers(page, ROUTING, ['Task class', 'Worker', 'Reason', 'Alternatives']);
      const r = await rows(page, ROUTING);
      assert.equal(await r.count(), 10);
      for (let i = 0; i < classes.length; i++) assert.equal((await cells(r.nth(i), 4))[0], classes[i]);
    });
  },
  AC7: async (page) => {
    await openSystem(page);
    await eventually(async () => {
      for (const key of classes) {
        const c = await cells(await namedRow(page, ROUTING, key), 4);
        assert.equal(c[1], verifier.has(key) ? 'codex-verifier' : 'claude-code', `${key} worker`);
        assert.ok(c[2].includes(reason(alternatives.has(key))), `${key} reason: ${c[2]}`);
      }
    });
  },
  AC8: async (page) => {
    await openSystem(page);
    await eventually(async () => {
      for (const key of classes) {
        const row = await namedRow(page, ROUTING, key);
        const value = (await cells(row, 4))[3];
        if (!alternatives.has(key)) { assert.equal(value, '—', `${key} alternatives`); continue; }
        const expected = key === 'build' || key === 'correction'
          ? [['codex-builder', 'disabled', '0'], ['opencode-local', 'disabled', '0']]
          : [['local-llm', key === 'log_summary' ? 'shadow' : 'unqualified', key === 'log_summary' ? '3' : '0']];
        // innerText preserves rendered spacing; worker boundaries delimit entries independent of list markup.
        const workers = [...value.matchAll(/\b(?:codex-builder|opencode-local|local-llm|claude-code|codex-verifier)\b/gu)];
        assert.deepEqual(workers.map((m) => m[0]), expected.map((e) => e[0]), `${key} alternative workers/order`);
        const allStatuses = value.match(/\b(?:unqualified|shadow|qualified|rejected|disabled)\b/gu) || [];
        assert.deepEqual(allStatuses, expected.map((e) => e[1]), `${key} statuses/count`);
        const allSamples = [...value.matchAll(/\b(\d+)\s+samples\b/gu)].map((m) => m[1]);
        assert.deepEqual(allSamples, expected.map((e) => e[2]), `${key} sample counts`);
        for (let i = 0; i < expected.length; i++) {
          const entry = value.slice(workers[i].index, workers[i + 1]?.index ?? value.length);
          assert.ok(new RegExp(`\\b${expected[i][1]}\\b`).test(entry), `${key} entry status`);
          assert.ok(new RegExp(`\\b${expected[i][2]}\\s+samples\\b`).test(entry), `${key} entry samples`);
        }
      }
    });
  },
  AC10: async (page) => {
    await openSystem(page);
    await visible(page.getByRole('heading', { level: 1, name: 'System', exact: true }));
    for (const name of ['Backups', 'Recent executor errors', 'Administrative operations (audit log)']) await heading(page, name);
    for (const label of ['Build', 'Executor jobs']) {
      // Exact visible label, scoped outside the two new tables to avoid matching a run's purpose.
      const labels = page.getByText(label, { exact: true }).filter({ hasNot: page.locator('table') });
      await eventually(async () => {
        let found = false;
        for (let i = 0; i < await labels.count(); i++) {
          const candidate = labels.nth(i);
          if (await candidate.isVisible() && await candidate.locator('xpath=ancestor::table').count() === 0) found = true;
        }
        assert.ok(found, `Missing tile label ${label}`);
      });
    }
    await eventually(async () => assert.equal(await page.title(), 'System · Agents'));
  },
  AC11: async (page) => {
    const responses = [];
    const listener = (response) => {
      const u = new URL(response.url());
      if (u.origin === base.origin && u.pathname === '/system' && response.request().method() === 'GET') responses.push(response);
    };
    page.on('response', listener);
    try {
      await page.goto(url('/'), { waitUntil: 'domcontentloaded' });
      const link = page.getByRole('link', { name: 'System', exact: true });
      await visible(link);
      await link.click();
      await page.waitForURL((u) => u.pathname === '/system', { timeout: 15000 });
      await heading(page, RUNS);
      await heading(page, ROUTING);
      await eventually(async () => {
        assert.ok(responses.length > 0, 'No HTTP response for System navigation (including prefetch)');
        assert.equal(responses.at(-1).status(), 200, 'System navigation HTTP status');
      });
    } finally { page.off('response', listener); }
  },
  AC12: async (page) => {
    await openSystem(page);
    async function snapshot() {
      const result = [];
      for (const name of [RUNS, ROUTING]) {
        const card = await section(page, name);
        assert.equal(await card.locator('button, form, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], textarea, select, [role="button"], [role="textbox"], [role="combobox"]').count(), 0, `${name} contains interactive controls`);
        result.push(await card.innerText());
      }
      return result;
    }
    // Wait for both promised tables to finish rendering before reading the sections.
    await eventually(async () => {
      assert.equal(await (await rows(page, RUNS)).count(), 2);
      assert.equal(await (await rows(page, ROUTING)).count(), 10);
    });
    const before = await snapshot();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await eventually(async () => assert.deepEqual(await snapshot(), before, 'Section text changed after reload'));
  },
};

for (const id of ids) {
  let context;
  let result;
  try {
    if (setupError) throw new Error(setupError);
    try { context = await browser.newContext(); }
    catch (error) { throw new Error(`HARNESS: cannot create browser context: ${error.message}`); }
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(20000);
    const auth = await page.goto(url('/auth/preview'), { waitUntil: 'domcontentloaded' });
    assert.ok(auth && auth.status() === 200, 'Preview owner sign-in did not return HTTP 200');
    await page.waitForURL((u) => u.pathname === '/', { timeout: 10000 });
    await checks[id](page);
    result = { criterion: id, result: 'pass' };
  } catch (error) {
    result = { criterion: id, result: 'fail', detail: String(error.message || error).slice(0, 1600) };
  } finally {
    if (context) await context.close().catch(() => {});
  }
  console.log(JSON.stringify(result));
}
if (browser) await browser.close().catch(() => {});
process.exitCode = 0;
