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
async function capabilities(page) {
  const heading = await visible(page.getByRole('heading', { level: 2, name: 'Project Capabilities', exact: true }));
  // The frozen contract specifies li/h3/dl, not a table. Anchor the section
  // on its h2 and nearest ancestor containing list items. Retain this repaired
  // selector from the supplied oracle; descendant::table caused the gate timeout.
  const section = heading.locator('xpath=ancestor::*[descendant::li][1]');
  await visible(section);
  const item = section.getByRole('listitem').filter({
    has: page.getByRole('heading', { level: 3, name: 'Demo Project', exact: true }),
  });
  await visible(item);
  return { section, item };
}
async function fields(item) {
  const dl = await visible(item.locator('dl'));
  const terms = dl.locator('dt');
  const definitions = dl.locator('dd');
  const count = await terms.count();
  assert.equal(await definitions.count(), count, 'Each description term must have one definition');
  const labels = [];
  const values = [];
  for (let i = 0; i < count; i++) {
    const term = await visible(terms.nth(i));
    const definition = await visible(definitions.nth(i));
    // Supports both direct dt/dd children and conventional div-wrapped pairs.
    assert.ok(await term.evaluate((node, index) => {
      const list = node.closest('dl');
      const pairs = [...list.querySelectorAll('dt, dd')].filter(el => el.closest('dl') === list);
      return pairs[index * 2] === node && pairs[index * 2 + 1]?.tagName === 'DD';
    }, i), 'Description list terms and definitions must be paired in order');
    labels.push((await term.innerText()).trim());
    values.push((await definition.innerText()).trim());
  }
  return { labels, values };
}

const checks = {
  AC1: async page => {
    await open(page, '/system');
    const { section, item } = await capabilities(page);
    assert.equal(await section.getByRole('listitem').count(), 1, 'Preview must show exactly one active project list item');
    assert.equal(await item.count(), 1, 'Expected exactly one Demo Project item');
    await visible(item.getByRole('heading', { level: 3, name: 'Demo Project', exact: true }));
  },
  AC2: async page => {
    await open(page, '/system');
    const { item } = await capabilities(page);
    const { labels, values } = await fields(item);
    assert.deepEqual(labels, ['Language', 'Framework', 'Package manager', 'Build', 'Test', 'Lint', 'Type check', 'Browser tests'], 'Description terms must match the specified order');
    for (const [index, expected] of [[0, 'typescript'], [1, 'next'], [2, 'npm']]) {
      assert.ok(values[index].toLowerCase().includes(expected), `${labels[index]} must contain ${expected}; got ${JSON.stringify(values[index])}`);
    }
    for (const [index, expected] of [[3, 'npm run build'], [4, 'npm run test'], [5, 'npm run lint']]) {
      assert.equal(values[index], expected, `${labels[index]} command differs`);
    }
  },
  AC3: async page => {
    await open(page, '/system');
    const { item } = await capabilities(page);
    const { labels, values } = await fields(item);
    for (const [label, expected] of [['Type check', 'Not detected'], ['Browser tests', 'Available']]) {
      assert.equal(labels.filter(value => value === label).length, 1, `Expected one ${label} term`);
      assert.equal(values[labels.indexOf(label)], expected, `${label} value differs`);
    }
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
    // A Build dt in the new profile must not stand in for the existing status card.
    for (const label of ['Build', 'Executor jobs']) {
      const candidates = page.getByText(label, { exact: true }).locator('xpath=self::*[not(ancestor::dl)]');
      await visible(candidates.first());
      let found = false;
      for (let i = 0; i < await candidates.count(); i++) {
        const candidate = candidates.nth(i);
        if (await candidate.isVisible() && await candidate.evaluate(el => !el.closest('dl'))) found = true;
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
    // AC5 specifies visible link text; an aria-label may give the link a different accessible name.
    const links = panel.getByRole('link');
    await visible(links.first());
    let matched = false;
    for (let i = 0; i < await links.count(); i++) {
      const link = links.nth(i);
      const href = await link.getAttribute('href');
      if (href && new URL(href, page.url()).href === `${baseURL}/projects/demo/new` && await link.isVisible() && (await link.innerText()).trim() === 'New intent') matched = true;
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
