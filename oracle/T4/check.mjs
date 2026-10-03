import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'];
let browser;
let base;
let setupError;
try {
  const input = process.argv[2];
  if (!input) throw new Error('Missing baseURL argument');
  base = new URL(input);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid baseURL protocol');
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (error) {
  setupError = `HARNESS: ${error.message}`;
}

async function visibleUnique(locator, label) {
  await locator.first().waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(await locator.count(), 1, `${label}: expected exactly one element`);
  assert.ok(await locator.isVisible(), `${label}: not visible`);
  return locator;
}

async function visit(page, path) {
  const response = await page.goto(new URL(path, base).href, { waitUntil: 'load', timeout: 30000 });
  assert.ok(response, `${path}: missing navigation response`);
  assert.equal(response.status(), 200, `${path}: expected HTTP 200, received ${response.status()}`);
  assert.equal(new URL(page.url()).pathname, path, `${path}: redirected to ${page.url()}`);
}

async function capabilities(page) {
  const heading = await visibleUnique(page.getByRole('heading', { level: 2, name: 'Project Capabilities', exact: true }), 'Project Capabilities h2');
  // The interface promises a card, but does not prescribe its tag or CSS classes.
  // Use its nearest ancestor containing the promised project list, without
  // accepting an ancestor that also encloses other h2-headed cards.
  const section = heading.locator('xpath=ancestor::*[.//li][1]');
  await visibleUnique(section, 'Project Capabilities section');
  assert.equal(await section.locator('h2').count(), 1, 'Project list must be within the Project Capabilities section');
  return section;
}

async function demo(page) {
  const section = await capabilities(page);
  const item = section.locator('li').filter({ has: page.getByRole('heading', { level: 3, name: 'Demo Project', exact: true }) });
  await visibleUnique(item, 'Demo Project list item');
  await visibleUnique(item.getByRole('heading', { level: 3, name: 'Demo Project', exact: true }), 'Demo Project h3');
  return item;
}

async function field(item, name) {
  const dl = await visibleUnique(item.locator('dl'), 'Demo Project description list');
  const term = dl.locator('dt').filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) });
  await visibleUnique(term, `${name} term`);
  const value = term.locator('xpath=following-sibling::*[1][self::dd]');
  await visibleUnique(value, `${name} definition`);
  return (await value.innerText()).trim();
}

const checks = {
  AC1: async (page) => {
    await visit(page, '/system');
    const section = await capabilities(page);
    await demo(page);
    assert.equal(await section.locator('li').count(), 1, 'Preview must have exactly one active-project list item');
  },
  AC2: async (page) => {
    await visit(page, '/system');
    const item = await demo(page);
    const dl = await visibleUnique(item.locator('dl'), 'Demo Project description list');
    const expected = ['Language', 'Framework', 'Package manager', 'Build', 'Test', 'Lint', 'Type check', 'Browser tests'];
    await dl.locator('dt').first().waitFor({ state: 'visible' });
    const labels = [];
    for (const term of await dl.locator('dt').all()) labels.push((await term.innerText()).trim());
    assert.deepEqual(labels, expected, 'Description terms and order');
    assert.equal(await dl.locator('dd').count(), expected.length, 'One definition per term');
    for (const [name, value] of [['Language', 'typescript'], ['Framework', 'next'], ['Package manager', 'npm']]) {
      assert.ok((await field(item, name)).toLowerCase().includes(value), `${name}: expected value containing ${value}`);
    }
    for (const [name, value] of [['Build', 'npm run build'], ['Test', 'npm run test'], ['Lint', 'npm run lint']]) {
      assert.equal(await field(item, name), value, `${name}: exact detected command`);
    }
  },
  AC3: async (page) => {
    await visit(page, '/system');
    const item = await demo(page);
    assert.equal(await field(item, 'Type check'), 'Not detected', 'Type check');
    assert.equal(await field(item, 'Browser tests'), 'Available', 'Browser tests');
  },
  AC4: async (page) => {
    const uncaught = [];
    page.on('pageerror', error => uncaught.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /\buncaught\b/i.test(message.text())) uncaught.push(message.text());
    });
    await visit(page, '/system');
    await visibleUnique(page.getByRole('heading', { level: 1, name: 'System', exact: true }), 'System h1');
    for (const name of ['Build', 'Executor jobs']) {
      const label = page.getByText(name, { exact: true }).locator('xpath=self::*[not(ancestor-or-self::dl)]');
      await visibleUnique(label, `${name} status card label`);
    }
    for (const name of ['Backups', 'Recent executor errors', 'Administrative operations (audit log)']) {
      await visibleUnique(page.getByRole('heading', { name, exact: true }), `${name} card heading`);
    }
    // Bounded observation allows hydration errors to surface without relying
    // on networkidle (the System page can refresh itself).
    await page.waitForTimeout(1500);
    assert.deepEqual(uncaught, [], 'Uncaught browser errors on /system');
  },
  AC5: async (page) => {
    await visit(page, '/');
    await visibleUnique(page.getByRole('heading', { level: 1, name: 'Command', exact: true }), 'Command h1');
    const heading = await visibleUnique(page.getByRole('heading', { name: 'Projects', exact: true }), 'Projects panel heading');
    const panel = heading.locator('xpath=ancestor::*[.//a[normalize-space(.)="New intent"]][1]');
    await visibleUnique(panel, 'Projects panel');
    // Locate the smallest project entry containing both its name and shortcut.
    const project = await visibleUnique(panel.getByText('Demo Project', { exact: true }), 'Demo Project in Projects panel');
    const entry = project.locator('xpath=ancestor::*[.//a[normalize-space(.)="New intent"]][1]');
    const link = await visibleUnique(entry.getByRole('link', { name: 'New intent', exact: true }), 'Demo Project New intent link');
    const href = await link.getAttribute('href');
    assert.ok(href, 'New intent link missing href');
    assert.equal(new URL(href, page.url()).href, new URL('/projects/demo/new', base).href, 'New intent link destination');
    for (const [path, name] of [['/decisions', 'Decisions'], ['/projects/demo', 'Demo Project']]) {
      await visit(page, path);
      await visibleUnique(page.getByRole('heading', { level: 1, name, exact: true }), `${path} h1`);
    }
  },
};

for (const criterion of ids) {
  let context;
  let result;
  try {
    if (setupError) throw new Error(setupError);
    try {
      context = await browser.newContext();
    } catch (error) {
      throw new Error(`HARNESS: browser context creation failed: ${error.message}`);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(30000);
    const auth = await page.goto(new URL('/auth/preview', base).href, { waitUntil: 'load' });
    assert.ok(auth && auth.status() === 200, 'Preview owner sign-in must redirect to a successful page');
    assert.equal(new URL(page.url()).pathname, '/', 'Preview owner sign-in must redirect to /');
    await checks[criterion](page);
    result = { criterion, result: 'pass' };
  } catch (error) {
    let detail = error.message || String(error);
    if (/net::ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE)|browser has been closed|Target page, context or browser has been closed/i.test(detail)) {
      detail = `HARNESS: preview or browser unavailable: ${detail}`;
    }
    result = { criterion, result: 'fail', detail: detail.slice(0, 1800) };
  } finally {
    if (context) await context.close().catch(() => {});
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (browser) await browser.close().catch(() => {});
process.exitCode = 0;
