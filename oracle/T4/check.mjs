import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'];
const timeout = 15000;
let browser;
let baseURL;
let setupError;
try {
  assert.ok(process.argv[2], 'Invocation requires a baseURL');
  baseURL = new URL(process.argv[2]).origin;
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (error) {
  setupError = `HARNESS: browser or invocation setup failed: ${error.message}`;
}

async function visible(locator) {
  await locator.waitFor({ state: 'visible', timeout });
  return locator;
}
async function open(page, path) {
  const response = await page.goto(`${baseURL}${path}`, { waitUntil: 'load', timeout: 30000 });
  assert.ok(response, `${path}: no document response`);
  assert.equal(response.status(), 200, `${path}: expected HTTP 200, got ${response.status()}`);
  assert.equal(new URL(page.url()).pathname, path, `${path}: unexpected redirect`);
}
const columns = ['Project', 'Language', 'Framework', 'Package manager', 'Build', 'Test', 'Lint', 'Type-check', 'Browser tests'];
async function capabilities(page) {
  const heading = await visible(page.getByRole('heading', { level: 2, name: 'Project Capabilities', exact: true }));
  // The nearest table-containing ancestor is the capabilities card, not an
  // ancestor selected through unrelated lists elsewhere on the page.
  const section = heading.locator('xpath=ancestor::*[descendant::table][1]');
  await visible(section);
  const table = await visible(section.getByRole('table'));
  const headers = table.getByRole('columnheader');
  assert.equal(await headers.count(), columns.length, 'Expected exactly nine column headers');
  const labels = [];
  for (let i = 0; i < columns.length; i++) {
    labels.push((await (await visible(headers.nth(i))).innerText()).trim());
  }
  assert.deepEqual(labels, columns, 'Table columns must match the specified order');
  const rows = table.locator(':scope > tbody > tr');
  assert.equal(await rows.count(), 1, 'Preview must show exactly one project body row');
  const row = await visible(rows.first());
  const cells = row.locator(':scope > td, :scope > th');
  assert.equal(await cells.count(), columns.length, 'Project row must contain nine cells');
  const values = [];
  for (let i = 0; i < columns.length; i++) {
    const cell = await visible(cells.nth(i));
    assert.equal(await cell.evaluate(el => el.colSpan), 1, 'Each project field must occupy its own column');
    // Read each visible cell independently, preserving boundaries between fields.
    values.push((await cell.innerText()).trim());
  }
  assert.equal(values[0], 'Demo Project', 'Project cell must identify Demo Project');
  return { values };
}

const checks = {
  AC1: async page => {
    await open(page, '/system');
    await capabilities(page);
  },
  AC2: async page => {
    await open(page, '/system');
    const { values } = await capabilities(page);
    for (const [index, expected] of [[1, 'typescript'], [2, 'next'], [3, 'npm']]) {
      assert.equal(values[index].toLowerCase(), expected, `${columns[index]} value differs`);
    }
    for (const index of [4, 5]) {
      assert.ok(values[index].startsWith('Available'), `${columns[index]} must start with Available; got ${JSON.stringify(values[index])}`);
    }
    assert.equal(values[6], 'Not available', 'Lint value differs');
  },
  AC3: async page => {
    await open(page, '/system');
    const { values } = await capabilities(page);
    assert.ok(values[7].startsWith('Available'), `Type-check must start with Available; got ${JSON.stringify(values[7])}`);
    assert.equal(values[8], 'Not available', 'Browser tests value differs');
  },
  AC4: async page => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /\buncaught\b/i.test(message.text())) errors.push(message.text());
    });
    await open(page, '/system');
    await visible(page.getByRole('heading', { level: 1, name: 'System', exact: true }));
    for (const name of ['Backups', 'Recent executor errors', 'Administrative operations (audit log)']) {
      await visible(page.getByRole('heading', { name, exact: true }));
    }
    // Capability table headers must not stand in for existing status card labels.
    for (const label of ['Build', 'Executor jobs']) {
      const candidates = page.getByText(label, { exact: true }).locator('xpath=self::*[not(ancestor::dl) and not(ancestor::table)]');
      await visible(candidates.first());
      let found = false;
      for (let i = 0; i < await candidates.count(); i++) {
        const candidate = candidates.nth(i);
        if (await candidate.isVisible() && await candidate.evaluate(el => !el.closest('dl, table'))) found = true;
      }
      assert.ok(found, `Missing visible ${label} status card label`);
    }
    // Give client hydration and its queued callbacks time to expose uncaught errors.
    await page.waitForTimeout(1500);
    assert.deepEqual(errors, [], 'Uncaught browser errors on /system');
  },
  AC5: async page => {
    await open(page, '/');
    const heading = await visible(page.getByRole('heading', { level: 2, name: 'Projects', exact: true }));
    const panel = heading.locator('xpath=ancestor::*[descendant::a][1]');
    await visible(panel.getByText('Demo Project', { exact: true }));
    // The contract specifies visible text; aria-label may add project context.
    const links = panel.getByRole('link');
    await visible(links.first());
    let matched = false;
    for (let i = 0; i < await links.count(); i++) {
      const link = links.nth(i);
      const href = await link.getAttribute('href');
      if (!await link.isVisible()) continue;
      // Read this link alone; permit the decorative + reported by the arbiter.
      const label = (await link.innerText()).replace(/\s+/g, ' ').trim();
      if (/^(?:\+\s*)?New intent(?:\s*\+)?$/.test(label) &&
          href && new URL(href, page.url()).href === `${baseURL}/projects/demo/new`) matched = true;
    }
    assert.ok(matched, 'Projects panel must include New intent linking to /projects/demo/new');
    await open(page, '/decisions');
    await visible(page.getByRole('heading', { level: 1, name: 'Decisions', exact: true }));
    await open(page, '/projects/demo');
    await visible(page.getByRole('heading', { level: 1, name: 'Demo Project', exact: true }));
  },
};

for (const criterion of ids) {
  let context;
  try {
    if (setupError) throw new Error(setupError);
    try {
      context = await browser.newContext();
    } catch (error) {
      throw new Error(`HARNESS: cannot create browser context: ${error.message}`);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    const auth = await page.goto(`${baseURL}/auth/preview`, { waitUntil: 'load', timeout: 30000 });
    assert.ok(auth && auth.status() === 200, 'Preview owner sign-in must finish with HTTP 200');
    assert.equal(new URL(page.url()).pathname, '/', 'Preview owner sign-in must redirect to /');
    await checks[criterion](page);
    process.stdout.write(`${JSON.stringify({ criterion, result: 'pass' })}\n`);
  } catch (error) {
    let detail = error.message || String(error);
    if (/net::ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED)/.test(detail)) {
      detail = `HARNESS: preview is unreachable: ${detail}`;
    }
    process.stdout.write(`${JSON.stringify({ criterion, result: 'fail', detail: detail.slice(0, 1800) })}\n`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
if (browser) await browser.close().catch(() => {});
process.exitCode = 0;
