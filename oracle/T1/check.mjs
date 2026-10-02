import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'];
let browser;
let base;
let setupError;
try {
  base = new URL(process.argv[2]);
  assert.ok(['http:', 'https:'].includes(base.protocol), 'Expected an HTTP baseURL');
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
} catch (error) {
  setupError = `HARNESS: browser or invocation setup failed: ${error.message}`;
}
const url = path => new URL(path, base).href;
const shortcut = item => item.getByRole('link', { name: /^New intent/ });

async function projects(page) {
  const heading = page.getByRole('heading', { level: 2, name: 'Projects', exact: true });
  await heading.waitFor({ state: 'visible' });
  assert.equal(await heading.count(), 1, 'Expected one Projects heading');
  // No implementation-specific classes or assumed panel tag.
  const panel = heading.locator('xpath=ancestor::*[.//li or .//*[@role="listitem"]][1]');
  const items = panel.getByRole('listitem');
  await items.first().waitFor({ state: 'visible' });
  return { panel, items };
}
async function demoItem(page) {
  const { items } = await projects(page);
  const item = items.filter({ has: page.getByRole('link', { name: /Demo Project/ }) });
  assert.equal(await item.count(), 1, 'Expected one Demo Project list item');
  await item.waitFor({ state: 'visible' });
  assert.match(await item.innerText(), /Demo Project/, 'Project item must show Demo Project');
  return item;
}
async function visible(locator) {
  await locator.waitFor({ state: 'visible' });
  assert.equal(await locator.count(), 1, 'Expected exactly one matching control');
}
async function navigate(page, context, path, activate, checkStatus = true) {
  const documents = [];
  const collect = response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()
        && response.url() === url(path)) documents.push(response);
  };
  page.on('response', collect);
  try {
    await Promise.all([
      page.waitForURL(target => target.href === url(path), { waitUntil: 'domcontentloaded' }),
      activate(),
    ]);
    assert.equal(page.url(), url(path), 'Unexpected final browser URL');
    if (checkStatus) {
      // Client-side routing may make no document request. In that case verify the
      // route's HTTP status through the same authenticated context, without a UI action.
      const response = documents.at(-1) ?? await context.request.get(url(path), { maxRedirects: 0 });
      assert.equal(response.status(), 200, `${path} must return HTTP 200`);
    }
  } finally {
    page.off('response', collect);
  }
}

const checks = {
  async AC1(page) {
    const item = await demoItem(page);
    const links = shortcut(item);
    await links.first().waitFor({ state: 'visible' });
    const hrefs = await links.evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    assert.ok(hrefs.includes('/projects/demo/new'), 'Demo Project must contain a New intent link to /projects/demo/new');
  },
  async AC2(page, context) {
    const link = shortcut(await demoItem(page));
    await visible(link);
    await navigate(page, context, '/projects/demo/new', () => link.click());
    await visible(page.getByRole('heading', { level: 1, name: 'New intent', exact: true }));
    await visible(page.getByRole('link', { name: '← Demo Project', exact: true }));
    await visible(page.getByLabel('Title', { exact: true }));
    await visible(page.getByLabel('What should be built or changed?', { exact: true }));
    await visible(page.getByRole('button', { name: 'Record intent', exact: true }));
  },
  async AC3(page) {
    const { panel, items } = await projects(page);
    const count = await items.count();
    assert.ok(count > 0, 'Expected seeded project list');
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      const link = shortcut(item);
      assert.equal(await link.count(), 1, `Project item ${i + 1} must contain exactly one New intent link`);
      const hrefs = await item.getByRole('link').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
      const projectPaths = [...new Set(hrefs.filter(href => /^\/projects\/[^/?#]+$/.test(href ?? '')))];
      assert.equal(projectPaths.length, 1, `Project item ${i + 1} must identify its project destination`);
      assert.equal(await link.getAttribute('href'), `${projectPaths[0]}/new`, `New intent href does not match project item ${i + 1}`);
    }
    assert.equal(await shortcut(panel).count(), count, 'Projects panel must contain one New intent link per project item');
  },
  async AC4(page, context) {
    const item = await demoItem(page);
    const link = item.getByRole('link', { name: /Demo Project/ }).and(item.locator('a[href="/projects/demo"]'));
    await visible(link);
    await navigate(page, context, '/projects/demo', () => link.click());
    await visible(page.getByRole('heading', { level: 1, name: 'Demo Project', exact: true }));
  },
  async AC5(page, context) {
    const link = shortcut(await demoItem(page));
    await visible(link);
    // Traverse the actual keyboard order; never programmatically focus the target.
    const visited = new Set();
    const budget = Math.max(100, await page.locator('*').count() * 2);
    let reached = false;
    for (let i = 0; i < budget; i++) {
      await page.keyboard.press('Tab');
      if (await link.evaluate(node => node === document.activeElement)) {
        reached = true;
        break;
      }
      const position = await page.evaluate(() => [...document.querySelectorAll('*')].indexOf(document.activeElement));
      if (visited.has(position)) break;
      visited.add(position);
    }
    assert.ok(reached, 'Tab traversal did not reach Demo Project New intent link');
    await navigate(page, context, '/projects/demo/new', () => page.keyboard.press('Enter'), false);
    await visible(page.getByRole('heading', { level: 1, name: 'New intent', exact: true }));
  },
};

for (const criterion of ids) {
  let context;
  let timer;
  try {
    if (setupError) throw new Error(setupError);
    try {
      context = await browser.newContext();
    } catch (error) {
      throw new Error(`HARNESS: cannot create browser context: ${error.message}`);
    }
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(20000);
    const work = async () => {
      const page = await context.newPage();
      try {
        await page.goto(url('/auth/preview'), { waitUntil: 'domcontentloaded' });
      } catch (error) {
        if (/ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE/.test(error.message)) {
          throw new Error(`HARNESS: preview unreachable: ${error.message}`);
        }
        throw error;
      }
      await page.waitForURL(target => target.href === url('/'), { waitUntil: 'domcontentloaded' });
      await checks[criterion](page, context);
    };
    await Promise.race([
      work(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Criterion did not complete within 90 seconds')), 90000); }),
    ]);
    process.stdout.write(`${JSON.stringify({ criterion, result: 'pass' })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ criterion, result: 'fail', detail: String(error.message ?? error).slice(0, 1600) })}\n`);
  } finally {
    clearTimeout(timer);
    if (context) await context.close().catch(() => {});
  }
}
if (browser) await browser.close().catch(() => {});
process.exitCode = 0;
