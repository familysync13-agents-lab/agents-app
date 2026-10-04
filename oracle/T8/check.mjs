import assert from 'node:assert/strict';

const HASH = 'ea3524e95164fa82395285b83ee8e5d34a7beced8fd0f31d4c774562be0e5b19';
const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };
let browser, baseURL, setupError;
try {
  baseURL = new URL(process.argv[2]).origin;
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (error) {
  setupError = `HARNESS: browser/baseURL setup failed: ${error.message}`;
}

async function settled(page) {
  await page.waitForLoadState('load');
  await page.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function owner(viewport) {
  let context;
  try { context = await browser.newContext({ viewport }); }
  catch (error) { throw new Error(`HARNESS: cannot create browser context: ${error.message}`); }
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(15000);
  const page = await context.newPage();
  try {
    const response = await page.goto(`${baseURL}/auth/preview`);
    assert(response?.ok(), 'Owner preview sign-in failed');
    await page.waitForURL(url => url.origin === baseURL && url.pathname === '/');
    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}
async function task(page, key) {
  const project = await page.goto(`${baseURL}/projects/demo`);
  assert.equal(project?.status(), 200, 'Demo Project response must be HTTP 200');
  await settled(page);
  // A task link may include its title as well as the documented key.
  const link = page.getByRole('link', { name: new RegExp(`(^|\\s)${key}(?=$|[\\s:·—–-])`) });
  await link.first().waitFor({ state: 'visible' });
  const candidates = [];
  for (let i = 0; i < await link.count(); i++) {
    const href = await link.nth(i).getAttribute('href');
    if (href && /^\/tasks\/[^/]+\/?$/.test(new URL(href, baseURL).pathname)) candidates.push(link.nth(i));
  }
  assert.equal(candidates.length, 1, `${key}: expected one task link on Demo Project`);
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'load' }),
    candidates[0].click(),
  ]);
  // Client-side navigation has no document response; request the same public route
  // with the owner's cookies to check its actual HTTP response in that case.
  assert.match(new URL(page.url()).pathname, /^\/tasks\/[^/]+\/?$/, `${key}: task route`);
  const status = response ? response.status() : (await page.request.get(page.url())).status();
  await page.getByRole('heading', { level: 2, name: 'Evidence package', exact: true }).waitFor({ state: 'visible' });
  await settled(page);
  return status;
}
function card(page) {
  return page.getByRole('heading', { level: 2, name: 'Evidence package', exact: true })
    .locator('xpath=ancestor::section[1] | self::*[not(ancestor::section)]/parent::*');
}
async function headings(page) {
  return page.locator('h2').allInnerTexts();
}
async function cardBounds(page, width) {
  return page.locator('h2').evaluateAll((nodes, width) => nodes.map(h => {
    const element = h.closest('section') || h.parentElement;
    const r = element.getBoundingClientRect();
    return { heading: h.innerText, left: r.left, right: r.right };
  }).filter(r => r.left < -1 || r.right > width + 1), width);
}
async function value(packageCard, label) {
  const term = packageCard.locator('dt').filter({ hasText: new RegExp(`^\\s*${label}\\s*$`) });
  assert.equal(await term.count(), 1, `Expected one description-list term ${label}`);
  await term.waitFor({ state: 'visible' });
  const dd = term.locator('xpath=following-sibling::*[1][self::dd]');
  assert.equal(await dd.count(), 1, `Missing description-list value for ${label}`);
  await dd.waitFor({ state: 'visible' });
  return dd;
}
async function fullHash(packageCard) {
  const dd = await value(packageCard, 'Package hash');
  assert.equal((await dd.innerText()).replace(/\s/g, ''), HASH, 'Package hash must remain full visible text');
  const clipped = await dd.evaluate(root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      for (let i = 0; i < node.length; i++) {
        if (/\s/.test(node.data[i])) continue;
        const range = document.createRange();
        range.setStart(node, i); range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (!rect.width || !rect.height) return true;
        for (let el = node.parentElement; el; el = el.parentElement) {
          const style = getComputedStyle(el), box = el.getBoundingClientRect();
          if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return true;
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX) &&
              (rect.left < box.left - 1 || rect.right > box.right + 1)) return true;
          if (['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY) && el !== document.body && el !== document.documentElement &&
              (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) return true;
        }
      }
    }
    return false;
  });
  assert(!clipped, 'Package hash characters must be visible, without clipping');
}

const checks = {
  AC1: async page => {
    for (const key of ['T1', 'T2', 'T3']) {
      assert.equal(await task(page, key), 200, `${key}: HTTP status`);
      assert.equal(await page.title(), 'Task · Agents', `${key}: document title`);
      const before = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, x: scrollX }));
      assert(before.width <= 375, `${key}: document scrollWidth ${before.width} > 375`);
      assert.equal(before.x, 0, `${key}: initial scrollX`);
      await page.evaluate(() => window.scrollBy(1000, 0));
      await settled(page);
      assert.equal(await page.evaluate(() => scrollX), 0, `${key}: document scrolls horizontally`);
    }
  },
  AC2: async page => {
    for (const key of ['T1', 'T2', 'T3']) {
      await task(page, key);
      assert((await page.locator('h2').count()) > 0, `${key}: no card headings`);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      assert(width <= 376, `${key}: document exceeds width tolerance: ${width}`);
      assert.deepEqual(await cardBounds(page, 375), [], `${key}: cards outside viewport`);
    }
  },
  AC3: async page => {
    await task(page, 'T3');
    const packageCard = card(page);
    const outside = await packageCard.evaluate(root => [root, ...root.querySelectorAll('*')].map(el => {
      const r = el.getBoundingClientRect();
      return { tag: el.tagName, left: r.left, right: r.right };
    }).filter(r => r.left < -1 || r.right > 376));
    assert.deepEqual(outside, [], 'Evidence package descendants outside viewport');
    await fullHash(packageCard);
  },
  AC4: async page => {
    for (const key of ['T1', 'T2', 'T3']) {
      await task(page, key);
      const main = page.getByRole('main');
      await main.waitFor({ state: 'visible' });
      const outside = await main.evaluate(root => {
        const visible = el => {
          const s = getComputedStyle(el);
          return el.getClientRects().length && s.display !== 'none' && !['hidden', 'collapse'].includes(s.visibility) && Number(s.opacity) !== 0;
        };
        const contained = el => {
          for (let a = el.parentElement; a; a = a.parentElement) {
            const r = a.getBoundingClientRect();
            if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(a).overflowX) && r.left >= -1 && r.right <= 376) return true;
          }
          return false;
        };
        return [...root.querySelectorAll('*')].filter(visible).filter(el => {
          const r = el.getBoundingClientRect();
          return (r.left < -1 || r.right > 376) && !contained(el);
        }).map(el => ({ tag: el.tagName, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })).slice(0, 20);
      });
      assert.deepEqual(outside, [], `${key}: visible overflow lacks an in-screen scrolling/clipping ancestor`);
      assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 375, `${key}: content widens page`);
      assert.deepEqual(await cardBounds(page, 375), [], `${key}: content widens cards`);
    }
  },
  AC5: async page => {
    for (const key of ['T3', 'T1']) {
      await page.setViewportSize(PHONE);
      await task(page, key);
      const narrow = await headings(page);
      await page.setViewportSize(DESKTOP);
      await task(page, key);
      assert((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, `${key}: desktop document overflow`);
      assert.deepEqual(await headings(page), narrow, `${key}: desktop h2 headings differ from phone`);
      if (key === 'T3') {
        const packageCard = card(page);
        assert.deepEqual((await packageCard.locator('dt').allInnerTexts()).map(s => s.trim()),
          ['Status', 'Required criteria verified', 'Verifier', 'Package hash'], 'Evidence package term order');
        assert.equal((await (await value(packageCard, 'Status')).innerText()).trim(), 'incomplete');
        assert.equal((await (await value(packageCard, 'Required criteria verified')).innerText()).trim(), '2 of 3');
        assert((await (await value(packageCard, 'Verifier')).innerText()).trim().startsWith('not_run'), 'Verifier must begin with not_run');
        await fullHash(packageCard);
      }
    }
  },
};
for (const [criterion, check] of Object.entries(checks)) {
  let context;
  try {
    if (setupError) throw new Error(setupError);
    const actor = await owner(PHONE);
    context = actor.context;
    await check(actor.page);
    console.log(JSON.stringify({ criterion, result: 'pass' }));
  } catch (error) {
    console.log(JSON.stringify({ criterion, result: 'fail', detail: String(error.message).slice(0, 1800) }));
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
if (browser) await browser.close().catch(() => {});
process.exitCode = 0;
