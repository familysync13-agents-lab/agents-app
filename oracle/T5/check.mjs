import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6'];
const headers = ['Project', 'Language', 'Framework', 'Package manager', 'Build', 'Test', 'Lint', 'Type-check', 'Browser tests'];
let browser;
let base;
let setupError;
try {
  base = new URL(process.argv[2]);
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (error) {
  setupError = `HARNESS: browser or baseURL setup failed: ${error.message}`;
}

async function visibleOne(locator, label) {
  await locator.first().waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await locator.count(), 1, `${label}: expected exactly one element`);
  return locator;
}
async function open(page, path) {
  const response = await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded', timeout: 25000 });
  assert.ok(response, `${path}: missing navigation response`);
  return response;
}
async function capabilities(page) {
  const heading = await visibleOne(page.getByRole('heading', { level: 2, name: 'Project Capabilities', exact: true }), 'Project Capabilities h2');
  assert.equal((await heading.innerText()).trim(), 'Project Capabilities');
  // The contract specifies a card, but does not require a particular tag or CSS class.
  const card = heading.locator('xpath=ancestor::*[descendant::table][1]');
  const table = await visibleOne(card.getByRole('table'), 'table in Project Capabilities card');
  return table;
}
async function demoCells(page) {
  const table = await capabilities(page);
  const project = table.getByRole('cell', { name: 'Demo Project', exact: true });
  await visibleOne(project, 'Demo Project cell');
  const row = project.locator('xpath=ancestor::tr[1]');
  const cells = row.getByRole('cell');
  const columns = table.getByRole('columnheader');
  const names = await columns.allInnerTexts();
  const mapped = {};
  for (const name of headers) {
    const matches = names.map((text, index) => text.trim() === name ? index : -1).filter(index => index >= 0);
    assert.equal(matches.length, 1, `Missing or duplicate column: ${name}`);
    const cell = cells.nth(matches[0]);
    await cell.waitFor({ state: 'visible' });
    mapped[name] = (await cell.innerText()).trim();
  }
  return mapped;
}

for (const criterion of ids) {
  let context;
  try {
    if (setupError) throw new Error(setupError);
    try {
      context = await browser.newContext();
    } catch (error) {
      throw new Error(`HARNESS: could not create browser context: ${error.message}`);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(25000);
    await open(page, '/auth/preview');
    await page.waitForURL(url => url.pathname === '/', { timeout: 25000 });

    if (criterion === 'AC6') {
      const links = page.getByRole('link', { name: 'System', exact: true });
      await links.first().waitFor({ state: 'visible' });
      let link;
      for (const candidate of await links.all()) {
        if (await candidate.isVisible()) { link = candidate; break; }
      }
      assert.ok(link, 'System navigation link is not visible');
      const navigationResponses = [];
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === base.origin && url.pathname === '/system' && response.request().isNavigationRequest()) navigationResponses.push(response);
      });
      await link.click();
      await page.waitForURL(url => url.origin === base.origin && url.pathname === '/system');
      await visibleOne(page.getByRole('heading', { level: 2, name: 'Project Capabilities', exact: true }), 'Project Capabilities h2');
      // Client-side navigation can use prefetched data without a document response.
      const response = navigationResponses.at(-1) ?? await context.request.get(page.url(), { timeout: 25000 });
      assert.equal(response.status(), 200, 'System navigation destination HTTP status');
    } else {
      const response = await open(page, '/system');
      if (criterion === 'AC1') {
        assert.equal(response.status(), 200, '/system HTTP status');
        const table = await capabilities(page);
        const columns = table.getByRole('columnheader');
        await columns.first().waitFor({ state: 'visible' });
        assert.deepEqual((await columns.allInnerTexts()).map(text => text.trim()), headers, 'Column headers and order');
        for (const column of await columns.all()) assert.ok(await column.isVisible(), 'Column header is hidden');
      } else if (criterion === 'AC2') {
        const table = await capabilities(page);
        const rows = table.locator('tbody tr');
        await rows.first().waitFor({ state: 'visible' });
        assert.equal(await rows.count(), 1, 'Preview must show exactly one project body row');
        const columns = (await table.getByRole('columnheader').allInnerTexts()).map(text => text.trim());
        const index = columns.indexOf('Project');
        assert.ok(index >= 0, 'Project column missing');
        const cell = rows.first().getByRole('cell').nth(index);
        await cell.waitFor({ state: 'visible' });
        assert.equal((await cell.innerText()).trim(), 'Demo Project');
      } else if (criterion === 'AC3') {
        const cells = await demoCells(page);
        for (const [name, expected] of Object.entries({ Language: 'typescript', Framework: 'next', 'Package manager': 'npm' })) {
          assert.equal(cells[name].toLowerCase(), expected, `${name} value`);
        }
      } else if (criterion === 'AC4') {
        const cells = await demoCells(page);
        for (const name of ['Build', 'Test', 'Type-check']) assert.ok(cells[name].startsWith('Available'), `${name} must start with Available; got ${cells[name]}`);
        for (const name of ['Lint', 'Browser tests']) assert.equal(cells[name], 'Not available', `${name} value`);
      } else if (criterion === 'AC5') {
        await visibleOne(page.getByRole('heading', { level: 1, name: 'System', exact: true }), 'System h1');
        for (const name of ['Backups', 'Recent executor errors', 'Administrative operations (audit log)']) {
          await visibleOne(page.getByRole('heading', { level: 2, name, exact: true }), `${name} h2`);
        }
        for (const name of ['Build', 'Executor jobs']) {
          // Tile labels have no specified role; table headers cannot satisfy them.
          const labels = page.getByText(name, { exact: true }).filter({ hasNot: page.locator('table') });
          await labels.first().waitFor({ state: 'visible' });
          let found = false;
          for (const label of await labels.all()) {
            if (await label.isVisible() && await label.locator('xpath=ancestor::table').count() === 0) found = true;
          }
          assert.ok(found, `${name} tile label must be visible outside tables`);
        }
        await page.waitForFunction(() => document.title === 'System · Agents');
        assert.equal(await page.title(), 'System · Agents');
      }
    }
    console.log(JSON.stringify({ criterion, result: 'pass' }));
  } catch (error) {
    let detail = String(error.message ?? error);
    if (/net::ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED)/.test(detail)) {
      detail = `HARNESS: preview is unreachable: ${detail}`;
    }
    console.log(JSON.stringify({ criterion, result: 'fail', detail: detail.slice(0, 1200) }));
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
if (browser) await browser.close().catch(() => {});
process.exitCode = 0;
