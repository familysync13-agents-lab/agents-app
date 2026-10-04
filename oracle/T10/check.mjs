import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3'];
const normalize = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
let browser;
let setupError;
let baseURL;
try {
  baseURL = new URL(process.argv[2]).href.replace(/\/$/, '');
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (error) {
  setupError = `HARNESS: browser or invocation setup failed: ${error.message}`;
}

// Compare each element's own textContent, never CSS-transformed innerText.
async function inspect(page) {
  return page.locator('body').evaluate((body) => {
    const norm = (text) => (text ?? '').replace(/\s+/g, ' ').trim();
    const visible = (element) => {
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && element.getClientRects().length > 0;
    };
    const elements = [...body.querySelectorAll('*')].filter(visible);
    const labels = (text) => elements.filter((el) => norm(el.textContent) === text);
    const review = labels('Needs your review');
    const noted = labels('Noted');
    const group = (matches) => matches.map((label) => {
      const list = label.nextElementSibling;
      return {
        isList: list?.matches('ul, [role="list"]') ?? false,
        visible: list ? visible(list) : false,
        items: list ? [...list.querySelectorAll('li, [role="listitem"]')].map((item) => ({
          text: norm(item.textContent), visible: visible(item),
        })) : [],
      };
    });
    return {
      review: group(review), noted: group(noted),
      reviewFirst: review.length === 1 && noted.length === 1
        && Boolean(review[0].compareDocumentPosition(noted[0]) & Node.DOCUMENT_POSITION_FOLLOWING),
      yourDecision: elements.some((el) => norm(el.textContent).toLowerCase() === 'your decision'),
      allItems: [...body.querySelectorAll('li, [role="listitem"]')].map((el) => norm(el.textContent)),
    };
  });
}

function checkGroup(groups, expected, name) {
  assert.equal(groups.length, 1, `Expected exactly one ${name} label`);
  assert.ok(groups[0].isList, `${name}: next sibling must be a list`);
  assert.ok(groups[0].visible, `${name}: list must be visible`);
  assert.deepEqual(groups[0].items.map((item) => item.text), expected, `${name}: incorrect item texts or order`);
  assert.ok(groups[0].items.every((item) => item.visible), `${name}: all items must be visible`);
}

function checkUnique(snapshot, texts) {
  for (const text of texts) {
    assert.equal(snapshot.allItems.filter((item) => item === text).length, 1, `Expected one page list item: ${text}`);
  }
}

async function openDecisions(page) {
  const response = await page.goto(`${baseURL}/decisions`, { waitUntil: 'load' });
  assert.equal(response?.status(), 200, '/decisions did not return HTTP 200');
  await page.locator('a[href^="/tasks/"]').first().waitFor({ state: 'visible' });
}

async function followTask(page, link) {
  await link.waitFor({ state: 'visible' });
  assert.equal(await link.count(), 1, 'Expected one matching task link');
  const href = await link.getAttribute('href');
  assert.match(href ?? '', /^\/tasks\/\d+$/, 'Task link must use /tasks/{decimal id}');
  await Promise.all([
    page.waitForURL((url) => url.pathname === href, { waitUntil: 'load' }),
    link.click(),
  ]);
  // Reload the actual destination to observe its document HTTP status even with client routing.
  const response = await page.reload({ waitUntil: 'load' });
  assert.equal(response?.status(), 200, `${href} did not return HTTP 200`);
  assert.equal(new URL(page.url()).pathname, href, 'Task navigation redirected elsewhere');
  await page.getByRole('heading', { level: 1 }).waitFor({ state: 'visible' });
}

for (const criterion of ids) {
  let context;
  try {
    if (setupError) throw new Error(setupError);
    try {
      context = await browser.newContext();
    } catch (error) {
      throw new Error(`HARNESS: unable to create browser context: ${error.message}`);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(25000);
    await page.goto(`${baseURL}/auth/preview`, { waitUntil: 'load' });
    await page.waitForURL((url) => url.pathname === '/', { waitUntil: 'load' });
    if (criterion === 'AC1' || criterion === 'AC2') {
      await openDecisions(page);
      const title = criterion === 'AC1' ? 'T4 · Demo: share a list' : 'T5 · Demo: book covers';
      const link = page.getByRole('link', { name: title, exact: true });
      await followTask(page, link);
      await page.getByText('Noted', { exact: true }).first().waitFor({ state: 'visible' });
      const snapshot = await inspect(page);
      if (criterion === 'AC1') {
        const reviewItems = [
          'AC1: [low] Demo finding: the share link is not shortened',
          'the independent Verifier did not check AC2 (the gate did)',
        ];
        const notedItems = ['AC3: should-criterion not verified'];
        checkGroup(snapshot.review, reviewItems, 'Needs your review');
        checkGroup(snapshot.noted, notedItems, 'Noted');
        assert.ok(snapshot.reviewFirst, 'Needs your review must precede Noted');
        checkUnique(snapshot, [...reviewItems, ...notedItems]);
      } else {
        assert.equal(snapshot.review.length, 0, 'Needs your review must be absent');
        const items = ['AC2: should-criterion not verified'];
        checkGroup(snapshot.noted, items, 'Noted');
        checkUnique(snapshot, items);
      }
    } else {
      const failures = [];
      for (const badge of ['Contract review', 'Decision']) {
        try {
          await openDecisions(page);
          const row = page.getByRole('listitem').filter({ has: page.getByText(badge, { exact: true }) });
          await followTask(page, row.getByRole('link').and(page.locator('a[href^="/tasks/"]')));
          const snapshot = await inspect(page);
          assert.ok(snapshot.yourDecision, 'Your decision must be visible (case-insensitive)');
          assert.equal(snapshot.review.length, 0, 'Needs your review must be absent');
          assert.equal(snapshot.noted.length, 0, 'Noted must be absent');
        } catch (error) {
          failures.push(`${badge}: ${error.message}`);
        }
      }
      assert.equal(failures.length, 0, failures.join('; '));
    }
    console.log(JSON.stringify({ criterion, result: 'pass' }));
  } catch (error) {
    console.log(JSON.stringify({ criterion, result: 'fail', detail: normalize(error.message).slice(0, 1800) }));
  } finally {
    await context?.close().catch(() => {});
  }
}
await browser?.close().catch(() => {});
