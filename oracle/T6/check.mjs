import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3', 'AC6', 'AC7', 'AC8', 'AC10', 'AC11', 'AC12'];
const runsName = 'Recent worker runs';
const routingName = 'Routing and qualification';
const classes = ['contract_draft', 'plan', 'build', 'correction', 'mutants', 'check_author', 'acceptance_check', 'attribution', 'failure_triage', 'log_summary'];
const alternatives = new Set(['build', 'correction', 'failure_triage', 'log_summary']);
const verifier = new Set(['check_author', 'acceptance_check', 'attribution', 'failure_triage']);
const reason = hasAlternative => hasAlternative
  ? 'trusted worker (no alternative has qualified for this class)'
  : 'trusted worker (no alternative is defined for this class)';
const norm = text => text.replace(/\s+/gu, ' ').trim();
let browser, context, setupError;
let base;
try {
  base = new URL(process.argv[2]);
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext();
  context.setDefaultTimeout(12000);
  context.setDefaultNavigationTimeout(20000);
} catch (error) {
  setupError = `HARNESS: browser/baseURL setup unavailable: ${error.message}`;
}

async function navigate(page, path) {
  try {
    return await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (/ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(error.message)) {
      throw new Error(`HARNESS: preview unreachable: ${error.message}`);
    }
    throw error;
  }
}
async function visible(locator) {
  await locator.waitFor({ state: 'visible' });
  assert.equal(await locator.count(), 1, 'Expected one matching visible element');
  return locator;
}
async function section(page, name) {
  const heading = page.getByRole('heading', { name, exact: true, level: 2 });
  await visible(heading);
  assert.equal((await heading.innerText()).trim(), name);
  // CardHeader may wrap the heading. Ascend only as far as its own table/card.
  const card = heading.locator('xpath=ancestor::*[descendant::table][1]');
  await visible(card);
  assert.equal(await card.locator('h2').count(), 1, `${name}: table must belong to its own section`);
  return card;
}
async function table(page, name) {
  const card = await section(page, name);
  return visible(card.getByRole('table'));
}
async function rows(page, name) {
  const t = await table(page, name);
  const bodyRows = t.locator('tbody > tr');
  await bodyRows.first().waitFor({ state: 'visible' });
  const result = [];
  for (const row of await bodyRows.all()) {
    await row.waitFor({ state: 'visible' });
    const cells = [];
    for (const cell of await row.getByRole('cell').all()) {
      await cell.waitFor({ state: 'visible' });
      cells.push(norm(await cell.innerText()));
    }
    result.push(cells);
  }
  return result;
}
async function routingRows(page) {
  const data = await rows(page, routingName);
  assert.equal(data.length, 10);
  const mapped = new Map();
  for (const row of data) {
    assert.equal(row.length, 4);
    assert.ok(classes.includes(row[0]), `Unknown task class ${row[0]}`);
    assert.ok(!mapped.has(row[0]), `Duplicate task class ${row[0]}`);
    mapped.set(row[0], row);
  }
  return mapped;
}
async function headers(page, name, expected) {
  const t = await table(page, name);
  const actual = [];
  for (const header of await t.getByRole('columnheader').all()) {
    await header.waitFor({ state: 'visible' });
    actual.push(norm(await header.innerText()));
  }
  assert.deepEqual(actual, expected);
}
async function snapshot(page) {
  const result = [];
  for (const name of [runsName, routingName]) {
    const card = await section(page, name);
    assert.equal(await card.locator('button, form, input:not([type]), input[type="text"], select, [role="button"], [role="textbox"], [role="combobox"]').count(), 0,
      `${name}: contains a prohibited control`);
    result.push(await card.innerText());
  }
  return result;
}

const checks = {
  AC1: async (page, response) => {
    assert.equal(response?.status(), 200);
    await headers(page, runsName, ['Task', 'Purpose', 'Worker', 'Task class', 'Reason', 'Context bytes']);
  },
  AC2: async page => {
    const data = await rows(page, runsName);
    assert.equal(data.length, 2);
    const expected = [['T3', 'build', 'claude-code', 'build', reason(true)], ['T1', 'draft_contract', 'claude-code', 'contract_draft', reason(false)]];
    for (let i = 0; i < expected.length; i++) {
      assert.equal(data[i].length, 6);
      for (let j = 0; j < 5; j++) {
        if (j === 1) {
          assert.ok(data[i][j] === expected[i][j] || new RegExp(`^${expected[i][j]}(?=\\s|[(:—–-])`).test(data[i][j]), 'Recorded purpose must precede any human label');
        } else assert.equal(data[i][j], expected[i][j]);
      }
    }
  },
  AC3: async page => {
    const data = await rows(page, runsName);
    for (const key of ['T3', 'T1']) {
      const matching = data.filter(row => row[0] === key);
      assert.equal(matching.length, 1, `Expected one ${key} run`);
      assert.equal(matching[0].length, 6);
      const value = matching[0][5].trim();
      assert.equal(key === 'T3' ? value.replace(/(?:bytes|B)$/, '').replace(/[,\s]/gu, '') : value, key === 'T3' ? '48213' : '—');
    }
  },
  AC6: async (page, response) => {
    assert.equal(response?.status(), 200);
    await headers(page, routingName, ['Task class', 'Worker', 'Reason', 'Alternatives']);
    assert.deepEqual((await rows(page, routingName)).map(row => row[0]), classes);
  },
  AC7: async page => {
    const data = await routingRows(page);
    for (const taskClass of classes) {
      assert.equal(data.get(taskClass)[1], verifier.has(taskClass) ? 'codex-verifier' : 'claude-code', `${taskClass}: Worker`);
      assert.ok(data.get(taskClass)[2].includes(reason(alternatives.has(taskClass))), `${taskClass}: Reason`);
    }
  },
  AC8: async page => {
    const data = await routingRows(page);
    for (const taskClass of classes) {
      const value = data.get(taskClass)[3];
      if (!alternatives.has(taskClass)) { assert.equal(value, '—'); continue; }
      const expected = ['build', 'correction'].includes(taskClass)
        ? [['codex-builder', 'disabled', '0'], ['opencode-local', 'disabled', '0']]
        : [['local-llm', taskClass === 'log_summary' ? 'shadow' : 'unqualified', taskClass === 'log_summary' ? '3' : '0']];
      // InnerText preserves separation between list items/lines. Partition by worker
      // identifiers, independent of whether entries use li, div, br, or punctuation.
      const workers = [...value.matchAll(/\b(?:codex-builder|opencode-local|local-llm)\b/g)];
      assert.deepEqual(workers.map(match => match[0]), expected.map(entry => entry[0]), `${taskClass}: alternative order/count`);
      assert.equal((value.match(/\b(?:unqualified|shadow|qualified|rejected|disabled)\b/g) || []).length, expected.length);
      assert.equal((value.match(/\b\d+\s+samples\b/g) || []).length, expected.length);
      for (let i = 0; i < workers.length; i++) {
        const entry = value.slice(workers[i].index, workers[i + 1]?.index ?? value.length);
        assert.deepEqual(entry.match(/\b(?:unqualified|shadow|qualified|rejected|disabled)\b/g), [expected[i][1]], `${taskClass}: status`);
        assert.deepEqual(entry.match(/\b\d+\s+samples\b/g), [`${expected[i][2]} samples`], `${taskClass}: samples`);
      }
    }
  },
  AC10: async page => {
    await visible(page.getByRole('heading', { name: 'System', exact: true, level: 1 }));
    for (const name of ['Backups', 'Recent executor errors', 'Administrative operations (audit log)']) {
      await visible(page.getByRole('heading', { name, exact: true, level: 2 }));
    }
    for (const name of ['Build', 'Executor jobs']) {
      // Exact casing avoids the recorded task class/purpose "build".
      await page.getByText(name, { exact: true }).first().waitFor({ state: 'visible' });
    }
    assert.equal(await page.title(), 'System · Agents');
  },
  AC11: async page => {
    await navigate(page, '/');
    const link = page.getByRole('link', { name: 'System', exact: true });
    await visible(link);
    await link.click();
    await page.waitForURL(url => url.pathname === '/system');
    assert.equal(new URL(page.url()).pathname, '/system');
    for (const name of [runsName, routingName]) await visible(page.getByRole('heading', { name, exact: true, level: 2 }));
    // Client navigation can use a prefetched response with no new request.
    // Reload the reached URL to observe its actual document HTTP status.
    const response = await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 200);
    assert.equal(new URL(page.url()).pathname, '/system');
    for (const name of [runsName, routingName]) await visible(page.getByRole('heading', { name, exact: true, level: 2 }));
  },
  AC12: async page => {
    const before = await snapshot(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.deepEqual(await snapshot(page), before);
  },
};

for (const criterion of ids) {
  let page;
  try {
    if (setupError) throw new Error(setupError);
    page = await context.newPage();
    await navigate(page, '/auth/preview');
    await page.waitForURL(url => url.pathname === '/');
    const response = criterion === 'AC11' ? null : await navigate(page, '/system');
    await checks[criterion](page, response);
    console.log(JSON.stringify({ criterion, result: 'pass' }));
  } catch (error) {
    console.log(JSON.stringify({ criterion, result: 'fail', detail: String(error.message || error).slice(0, 1200) }));
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
if (browser) await browser.close().catch(() => {});
