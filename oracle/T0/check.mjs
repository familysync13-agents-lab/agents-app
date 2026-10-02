import assert from 'node:assert/strict';

const SHORT = 'Approve the contract for T1: Demo: export a list as CSV';
const LONG = 'Should reading progress be computed per book from the pages a reader marks as read, or per list from the number of books marked finished, and should it be visible to people who open the list through a share link or only to the owner of the list?';
const HEADING = 'Trust boundary - your decision is required';
const criteria = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'];
let browser, context, page, setupError;
const emitted = new Set();
const deadline = setTimeout(() => {
  for (const criterion of criteria) {
    if (!emitted.has(criterion)) console.log(JSON.stringify({ criterion, result: 'fail', detail: 'HARNESS: oracle exceeded its total runtime budget before completing this criterion' }));
  }
  process.exit(0);
}, 540000);
deadline.unref();
const base = process.argv[2];
const size = value => [...value].length;
function message(error) { return String(error?.message ?? error).slice(0, 1200); }

try {
  if (!base) throw new Error('HARNESS: missing baseURL argument');
  new URL(base);
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch (error) { throw new Error(`HARNESS: playwright unavailable: ${message(error)}`); }
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    context = await browser.newContext();
    context.setDefaultTimeout(12000);
    context.setDefaultNavigationTimeout(20000);
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(20000);
  } catch (error) { throw new Error(`HARNESS: browser setup failed: ${message(error)}`); }
} catch (error) { setupError = error; }

async function navigate(path) {
  let response;
  try { response = await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded' }); }
  catch (error) {
    if (/ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ENOTFOUND|ECONNREFUSED/.test(message(error))) {
      throw new Error(`HARNESS: preview unreachable: ${message(error)}`);
    }
    throw error;
  }
  assert(response, `No navigation response for ${path}`);
  assert.equal(response.status(), 200, `${path} HTTP status`);
  return response;
}
async function signIn() {
  await navigate('/auth/preview');
  await page.waitForURL(url => url.pathname === '/');
}
async function list(path) {
  await navigate(path);
  if (path === '/decisions') await page.getByRole('heading', { name: 'Decisions', exact: true }).waitFor();
  const header = path === '/decisions'
    ? page.getByText('Open', { exact: true })
    : page.getByRole('heading', { name: HEADING, exact: true });
  await header.waitFor({ state: 'visible' });
  // Find the smallest enclosing card/section with actual list items and task links.
  const scope = header.locator('xpath=ancestor::*[.//*[self::li or @role="listitem"]//a[starts-with(@href,"/tasks/")]][1]');
  await scope.waitFor({ state: 'visible' });
  const items = scope.locator('li, [role="listitem"]').filter({ has: page.locator('a[href^="/tasks/"]') });
  await items.first().waitFor({ state: 'visible' });
  return items;
}
async function entry(path, key) {
  const items = await list(path);
  const item = items.filter({ hasText: new RegExp(`Demo Project\\s*·\\s*${key}(?![0-9A-Za-z])`) });
  assert.equal(await item.count(), 1, `Expected one Demo Project · ${key} decision in ${path}`);
  await item.waitFor({ state: 'visible' });
  return item;
}
async function titleOf(item, expected) {
  // Read visible elements independently; never concatenate textContent fields.
  const candidates = await item.evaluate((root, full) => {
    const visible = e => !!(e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden';
    return [root, ...root.querySelectorAll('*')]
      .filter(e => visible(e) && typeof e.innerText === 'string')
      .map(e => e.innerText)
      .filter(text => {
        const prefix = text.endsWith('…') ? text.slice(0, -1).trimEnd() : text;
        return prefix.length > 0 && (full.startsWith(prefix) || text.startsWith(full.slice(0, 24)));
      });
  }, expected);
  assert(candidates.length, 'Cannot find the visible decision title element');
  // The smallest matching visible field excludes enclosing metadata/explanation text.
  return candidates.sort((a, b) => size(a) - size(b))[0];
}
async function linkOf(item) {
  const links = item.locator('a[href^="/tasks/"]');
  assert.equal(await links.count(), 1, 'Decision must contain one task link');
  const href = await links.getAttribute('href');
  const url = new URL(href, base);
  assert.equal(url.origin, new URL(base).origin, 'Task link origin');
  assert.match(url.pathname, /^\/tasks\/[^/]+$/, 'Task link route');
  return { link: links, url };
}
async function taskTitle(link, url) {
  await Promise.all([
    page.waitForURL(current => current.pathname === url.pathname),
    link.click(),
  ]);
  // Client navigation need not issue a document response. Check the task HTTP status separately.
  const response = await context.request.get(url.href);
  assert.equal(response.status(), 200, 'T2 task page HTTP status');
  assert.equal(new URL(response.url()).pathname, url.pathname, 'Task request must not redirect elsewhere');
  await page.getByText('Demo: reading progress', { exact: true }).first().waitFor({ state: 'visible' });
  const label = page.getByText('Your decision', { exact: true });
  await label.waitFor({ state: 'visible' });
  const block = label.locator('xpath=ancestor::*[.//h2][1]');
  const heading = block.getByRole('heading', { level: 2, name: LONG, exact: true });
  await heading.waitFor({ state: 'visible' });
  assert.equal(await heading.innerText(), LONG, 'Full title in Your decision h2');
  assert(!(await heading.innerText()).includes('…'), 'Task title contains an ellipsis');
}
async function assertShortenedEntry(item) {
  const title = await titleOf(item, LONG);
  assert(size(title) <= 100, `T2 displayed title is ${size(title)} code points`);
  assert(title.endsWith('…'), 'T2 displayed title must end with U+2026');
  const prefix = title.slice(0, -1).trimEnd();
  assert(prefix.length > 0 && LONG.startsWith(prefix), 'T2 displayed title must be a nonempty prefix');
  const text = await item.innerText();
  assert(!text.includes(LONG), 'Full long title is visible inside the list item');
}
async function shortened(path, kind) {
  const item = await entry(path, 'T2');
  await assertShortenedEntry(item);
  const text = await item.innerText();
  assert(text.includes('Demo Project · T2'), 'Missing Demo Project · T2 metadata');
  await item.getByText(kind, { exact: true }).waitFor({ state: 'visible' });
  const { link, url } = await linkOf(item);
  // Identify the target by its documented task name, not an assumed seeded numeric id.
  await Promise.all([page.waitForURL(current => current.pathname === url.pathname), link.click()]);
  await page.getByText('Demo: reading progress', { exact: true }).first().waitFor({ state: 'visible' });
}

const checks = {
  AC1: () => shortened('/decisions', 'Decision'),
  AC2: () => shortened('/', 'Decide'),
  AC3: async () => {
    for (const path of ['/decisions', '/']) {
      const item = await entry(path, 'T1');
      assert.equal(await titleOf(item, SHORT), SHORT, `T1 title in ${path}`);
      assert(!(await item.innerText()).includes(`${SHORT}…`), 'Ellipsis appended to short title');
    }
  },
  AC4: async () => {
    const targets = [];
    for (const path of ['/decisions', '/']) {
      const item = await entry(path, 'T2');
      // AC4 starts from the shortened entry. A full destination heading alone
      // also exists before the feature and cannot establish this criterion.
      await assertShortenedEntry(item);
      const { link, url } = await linkOf(item);
      targets.push(url.pathname);
      await taskTitle(link, url);
    }
    assert.equal(targets[0], targets[1], 'Both entries must link to the same T2 task');
  },
  AC5: async () => {
    for (const path of ['/decisions', '/']) {
      const items = await list(path);
      const count = await items.count();
      assert(count >= 2, `Expected seeded open decisions in ${path}`);
      for (let i = 0; i < count; i++) {
        const item = items.nth(i);
        await item.waitFor({ state: 'visible' });
        const { url } = await linkOf(item);
        // Obtain each full title from its documented task-page decision heading,
        // including any additional decisions in a database reused by the gate.
        const detail = await context.newPage();
        let full;
        try {
          const response = await detail.goto(url.href, { waitUntil: 'domcontentloaded' });
          assert.equal(response?.status(), 200, 'Decision task HTTP status');
          const label = detail.getByText('Your decision', { exact: true });
          await label.waitFor({ state: 'visible' });
          const heading = label.locator('xpath=ancestor::*[.//h2][1]').getByRole('heading', { level: 2 });
          await heading.waitFor({ state: 'visible' });
          full = await heading.innerText();
        } finally { await detail.close(); }
        const title = await titleOf(item, full);
        assert(size(title) <= 100, `${path} decision ${i + 1}: ${size(title)} code points exceeds 100`);
      }
    }
  },
};
for (const criterion of criteria) {
  try {
    if (setupError) throw setupError;
    await signIn();
    await checks[criterion]();
    emitted.add(criterion);
    console.log(JSON.stringify({ criterion, result: 'pass' }));
  } catch (error) {
    emitted.add(criterion);
    console.log(JSON.stringify({ criterion, result: 'fail', detail: message(error) }));
  }
}
try { await browser?.close(); } catch { /* Results have already been emitted. */ }
clearTimeout(deadline);
process.exitCode = 0;
