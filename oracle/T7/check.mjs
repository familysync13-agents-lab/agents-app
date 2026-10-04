import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7'];
const terms = ['Status', 'Required criteria verified', 'Verifier', 'Package hash'];
const hash = 'ea3524e95164fa82395285b83ee8e5d34a7beced8fd0f31d4c774562be0e5b19';
let browser;
let base;
let setupError;
try {
  base = new URL(process.argv[2]);
  assert.ok(['http:', 'https:'].includes(base.protocol), 'baseURL must use HTTP or HTTPS');
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 20000 });
} catch (error) {
  setupError = `HARNESS: browser or invocation setup failed: ${error.message}`;
}

function detail(error) {
  const message = String(error?.message ?? error);
  if (/net::ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED)/.test(message)) {
    return `HARNESS: preview is unreachable: ${message}`.slice(0, 900);
  }
  return message.slice(0, 900);
}

async function eventually(check, label) {
  const deadline = Date.now() + 12000;
  let last;
  do {
    try { return await check(); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${last?.message ?? 'timed out'}`);
}

async function openTask(page, key) {
  const auth = await page.goto(new URL('/auth/preview', base).href, { waitUntil: 'domcontentloaded' });
  assert.equal(auth?.status(), 200, 'Owner preview sign-in must succeed');
  assert.equal(new URL(page.url()).pathname, '/', 'Preview sign-in must redirect to /');
  const project = await page.goto(new URL('/projects/demo', base).href, { waitUntil: 'domcontentloaded' });
  assert.equal(project?.status(), 200, 'Demo Project must open');
  // Match the task key within its own element: adjacent title text can make
  // the link's aggregated text "T1Demo: ..." without a textual boundary.
  const links = page.getByRole('link').filter({ has: page.getByText(key, { exact: true }) });
  const taskLinks = links.and(page.locator('a[href^="/tasks/"]'));
  await eventually(async () => assert.equal(await taskLinks.count(), 1, `Expected one task link for ${key}`), 'Find demo task');
  const href = await taskLinks.getAttribute('href');
  const target = new URL(href, base);
  assert.equal(target.origin, base.origin, 'Task link must remain on preview');
  assert.match(target.pathname, /^\/tasks\/[^/]+\/?$/, 'Task link must use /tasks/{id}');
  const [navigation] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
    taskLinks.click(),
  ]);
  await page.waitForURL(url => url.pathname === target.pathname, { timeout: 15000 });
  // Client-side routing may have no document response. Fetch the same document
  // by reloading in that case, so the asserted HTTP status is a real response.
  const response = navigation ?? await page.reload({ waitUntil: 'domcontentloaded' });
  return response;
}

async function cardFor(page, empty = false) {
  const heading = page.getByRole('heading', { name: 'Evidence package', exact: true, level: 2 });
  await heading.first().waitFor({ state: 'visible' });
  assert.equal(await heading.count(), 1, 'Expected exactly one h2 Evidence package');
  assert.equal((await heading.innerText()).trim(), 'Evidence package');
  // No classes or component internals are prescribed. Find the smallest shared
  // container of the heading and its documented body, excluding page roots.
  const body = empty
    ? "descendant::*[normalize-space(.)='No evidence package yet.']"
    : 'descendant::dl';
  const card = heading.locator(`xpath=ancestor::*[${body}][1]`);
  await card.waitFor({ state: 'visible' });
  assert.ok(!['BODY', 'HTML', 'MAIN'].includes(await card.evaluate(el => el.tagName)), 'Evidence package needs its own card container');
  return card;
}

async function field(card, label) {
  const term = card.locator('dt').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) });
  await eventually(async () => assert.equal(await term.count(), 1, `Expected one description term ${label}`), label);
  await term.waitFor({ state: 'visible' });
  const value = term.locator('xpath=following-sibling::*[1][self::dd]');
  assert.equal(await value.count(), 1, `${label} must be followed by its dd value`);
  await value.waitFor({ state: 'visible' });
  return (await value.innerText()).trim();
}

async function noControls(card) {
  assert.equal(await card.locator('button, form, input:not([type]), input[type="text" i], select, [role="button"], [role="textbox"], [role="combobox"]').count(), 0,
    'Evidence package card must contain no button, form, text input or select');
}

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
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(20000);
    const response = await openTask(page, criterion === 'AC6' ? 'T1' : 'T3');
    const card = await cardFor(page, criterion === 'AC6');
    if (criterion === 'AC1') {
      assert.equal(response?.status(), 200, 'T3 task document must return HTTP 200');
      await eventually(async () => assert.equal(await page.title(), 'Task · Agents'), 'Document title');
      const lists = card.locator('dl');
      assert.equal(await lists.count(), 1, 'Expected one evidence description list');
      assert.deepEqual(await lists.locator('dt').allInnerTexts().then(items => items.map(item => item.trim())), terms,
        'Description terms must match in order');
      for (const label of terms) await field(card, label);
    } else if (criterion === 'AC2') {
      assert.equal(await field(card, 'Status'), 'incomplete');
    } else if (criterion === 'AC3') {
      assert.equal(await field(card, 'Required criteria verified'), '2 of 3');
    } else if (criterion === 'AC4') {
      const value = await field(card, 'Verifier');
      assert.ok(value.startsWith('not_run'), 'Verifier value must begin with not_run');
      for (const forbidden of ['no_defect_found', 'defects', 'findings', 'unknown']) {
        assert.ok(!value.includes(forbidden), `Verifier value must not contain ${forbidden}`);
      }
    } else if (criterion === 'AC5') {
      assert.equal((await field(card, 'Package hash')).replace(/\s/g, ''), hash);
    } else if (criterion === 'AC6') {
      assert.equal(response?.status(), 200, 'T1 task document must return HTTP 200');
      await card.getByText('No evidence package yet.', { exact: true }).waitFor({ state: 'visible' });
      for (const label of terms) {
        assert.equal(await card.locator('dt').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) }).count(), 0,
          `Empty card must not contain description term ${label}`);
      }
    } else if (criterion === 'AC7') {
      // Wait for the recorded fields before taking the visible-text snapshot.
      for (const label of terms) await field(card, label);
      await noControls(card);
      const before = await card.innerText();
      await page.reload({ waitUntil: 'domcontentloaded' });
      const afterCard = await cardFor(page);
      for (const label of terms) await field(afterCard, label);
      assert.equal(await afterCard.innerText(), before, 'Card visible text must remain identical after reload');
      await noControls(afterCard);
    }
    process.stdout.write(`${JSON.stringify({ criterion, result: 'pass' })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ criterion, result: 'fail', detail: detail(error) })}\n`);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
if (browser) await browser.close().catch(() => {});
process.exitCode = 0;
