import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'];
const normalize = value => (value ?? '').replace(/\s+/g, ' ').trim();
const fixtures = [
  { key: 'T4', title: 'Demo: share a list', statement: '2 items would be accepted without proof' },
  { key: 'T5', title: 'Demo: book covers', statement: 'Nothing is accepted without proof' },
];
const counted = /^\d+ items? would be accepted without proof$/;
const isStatement = text => counted.test(text) || text === 'Nothing is accepted without proof';
let browser;
let baseURL;
let setupError;
try {
  baseURL = new URL(process.argv[2]).origin;
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (error) {
  setupError = `HARNESS: browser/URL setup failed: ${error.message}`;
}

async function eventually(read, predicate, message) {
  const deadline = Date.now() + 10000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(message);
}

// Inspect each element separately, preserving its own source wording regardless
// of CSS text-transform. All browser-side variables are local to this callback.
async function visibleTexts(root) {
  return root.evaluate(element => {
    return [element, ...element.querySelectorAll('*')].filter(node => {
      const style = getComputedStyle(node);
      return style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        node.getClientRects().length > 0;
    }).map(node => (node.textContent ?? '').replace(/\s+/g, ' ').trim());
  });
}

async function openDecisions(page) {
  const response = await page.goto(`${baseURL}/decisions`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Decisions', exact: true, level: 1 }).waitFor();
  await page.getByRole('listitem').first().waitFor();
  return response;
}

async function acceptanceItem(page, fixture) {
  const text = `${fixture.key} · ${fixture.title}`;
  const matchingItems = async () => {
    const result = [];
    const items = page.getByRole('listitem');
    for (let i = 0; i < await items.count(); i++) {
      const item = items.nth(i);
      if (!await item.isVisible()) continue;
      const links = item.getByRole('link');
      for (let j = 0; j < await links.count(); j++) {
        const link = links.nth(j);
        if (await link.isVisible() && /^\/tasks\/\d+$/.test(await link.getAttribute('href') ?? '') &&
            normalize(await link.textContent()) === text) {
          result.push(item);
          break;
        }
      }
    }
    return result;
  };
  const matches = await eventually(matchingItems, items => items.length > 0, `Missing task link ${text}`);
  assert.equal(matches.length, 1, `Expected exactly one list item for ${text}`);
  return matches[0];
}

async function badgeItem(page, label) {
  const matches = await eventually(async () => {
    const found = [];
    const items = page.getByRole('listitem');
    for (let i = 0; i < await items.count(); i++) {
      const item = items.nth(i);
      if (await item.isVisible() && (await visibleTexts(item)).includes(label)) found.push(item);
    }
    return found;
  }, items => items.length > 0, `Missing ${label} list item`);
  assert.equal(matches.length, 1, `Expected exactly one ${label} list item`);
  return matches[0];
}

async function singleLink(item, expectedText) {
  const links = item.getByRole('link', { includeHidden: true });
  assert.equal(await links.count(), 1, 'List item must contain exactly one link');
  await links.waitFor({ state: 'visible' });
  const href = await links.getAttribute('href');
  assert.match(href ?? '', /^\/tasks\/\d+$/, 'Task href must use a decimal id');
  const text = normalize(await links.textContent());
  if (expectedText !== undefined) assert.equal(text, expectedText, 'Task link text');
  return { link: links, href, text };
}

async function followTask(page, context, item, key, title) {
  const { link, href } = await singleLink(item, title === undefined ? undefined : `${key} · ${title}`);
  // Next.js can navigate without a document response. Check the destination's
  // HTTP status through the same authenticated context, and actually click too.
  const response = await context.request.get(`${baseURL}${href}`);
  assert.equal(response.status(), 200, `HTTP status for ${href}`);
  await Promise.all([
    page.waitForURL(url => url.origin === baseURL && url.pathname === href),
    link.click(),
  ]);
  await eventually(() => page.title(), titleText => titleText === 'Task · Agents', 'Incorrect task document title');
  const heading = page.getByRole('heading', { level: 1 });
  await heading.waitFor();
  await eventually(() => heading.textContent(), value => {
    const text = normalize(value);
    return text.includes(key) && (title === undefined || text.includes(title));
  }, `Task h1 does not contain ${key}${title ? ` and ${title}` : ''}`);
}

async function snapshot(page) {
  const result = [];
  for (const fixture of fixtures) {
    const item = await acceptanceItem(page, fixture);
    assert.equal(await item.locator('button, form, input, select, textarea').count(), 0, 'Acceptance item contains an interactive control');
    const { href, text } = await singleLink(item, `${fixture.key} · ${fixture.title}`);
    const statements = await eventually(() => visibleTexts(item), values => values.some(isStatement), `Missing proof statement for ${fixture.key}`);
    // Nested elements can expose the same whole text; compare distinct wording.
    const proof = [...new Set(statements.filter(isStatement))].sort();
    assert.equal(proof.length, 1, 'Expected one proof statement wording');
    result.push({ href, text, statement: proof[0] });
  }
  return result;
}

for (const criterion of ids) {
  let context;
  try {
    if (setupError) throw new Error(setupError);
    context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(20000);
    await page.goto(`${baseURL}/auth/preview`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(url => url.origin === baseURL && url.pathname === '/');
    const response = await openDecisions(page);
    if (criterion === 'AC1' || criterion === 'AC2') {
      if (criterion === 'AC1') assert.equal(response?.status(), 200, '/decisions HTTP status');
      const fixture = fixtures[criterion === 'AC1' ? 0 : 1];
      const item = await acceptanceItem(page, fixture);
      const texts = await eventually(() => visibleTexts(item), values => values.includes('Acceptance') && values.includes(fixture.statement), `Missing Acceptance badge or ${fixture.statement}`);
      assert(texts.includes('Acceptance'), 'Missing Acceptance badge');
      assert(texts.includes(fixture.statement), 'Missing expected proof statement');
      assert(!texts.some(text => isStatement(text) && text !== fixture.statement), 'Conflicting proof statement');
    } else if (criterion === 'AC3') {
      for (const fixture of fixtures) {
        await openDecisions(page);
        await followTask(page, context, await acceptanceItem(page, fixture), fixture.key, fixture.title);
      }
    } else if (criterion === 'AC4') {
      const before = await snapshot(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Decisions', exact: true, level: 1 }).waitFor();
      assert.deepEqual(await snapshot(page), before, 'Acceptance facts changed after reload');
    } else if (criterion === 'AC5') {
      for (const [label, key] of [['Contract review', 'T1'], ['Decision', 'T2']]) {
        await openDecisions(page);
        const item = await badgeItem(page, label);
        assert(!(await visibleTexts(item)).some(text => /accepted without proof/i.test(text)), `${label} contains a proof statement`);
        await followTask(page, context, item, key);
      }
    }
    console.log(JSON.stringify({ criterion, result: 'pass' }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const infrastructure = /net::ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED)|browser has been closed|Target page, context or browser has been closed/i.test(message);
    console.log(JSON.stringify({ criterion, result: 'fail', detail: `${infrastructure && !message.startsWith('HARNESS:') ? 'HARNESS: ' : ''}${message}`.slice(0, 1500) }));
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
if (browser) await browser.close().catch(() => {});
process.exitCode = 0;
