import assert from 'node:assert/strict';

const criteria = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7'];
const malformed = ['invalid', '1.5', '-3', '0', '+5', '1e3', '0x10', 'NaN', 'Infinity', '12abc'];
const absent = ['999999', '99999999999'];
const notFound = 'This page could not be found.';
let browser;
let baseURL;
let setupError;

try {
  baseURL = new URL(process.argv[2]);
  assert(['http:', 'https:'].includes(baseURL.protocol), 'baseURL must be HTTP(S)');
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], timeout: 15000 });
} catch (error) {
  setupError = `HARNESS: browser or invocation setup failed: ${error.message}`;
}

function evidence(page) {
  return page.getByRole('heading', { level: 2, name: 'Evidence package', exact: true });
}

async function noVisible(locator, description) {
  for (let i = 0; i < await locator.count(); i++) {
    assert(!(await locator.nth(i).isVisible()), description);
  }
}

async function navigate(page, path) {
  const response = await page.goto(new URL(path, baseURL).href, { waitUntil: 'load', timeout: 10000 });
  assert(response, `${path}: missing navigation response`);
  return response;
}

async function checkAddresses(page, identifiers, serverErrorsOnly = false) {
  const failures = [];
  for (const id of identifiers) {
    const path = `/tasks/${id}`;
    try {
      const response = await navigate(page, path);
      if (serverErrorsOnly) {
        assert(response.status() < 500 || response.status() > 599, `HTTP ${response.status()} is a server error`);
        // A positive readiness signal also rules out a blank or unrelated error page.
        await page.getByText(notFound, { exact: true }).first().waitFor({ state: 'visible', timeout: 4000 });
        await noVisible(page.getByText('Application error', { exact: false }), 'visible Application error');
        await noVisible(page.getByText('Internal Server Error', { exact: false }), 'visible Internal Server Error');
      } else {
        assert.equal(response.status(), 404, `expected HTTP 404, received ${response.status()}`);
        await page.getByText(notFound, { exact: true }).first().waitFor({ state: 'visible', timeout: 4000 });
        assert.equal(await evidence(page).count(), 0, 'unexpected h2 Evidence package');
      }
    } catch (error) {
      failures.push(`${path}: ${error.message}`);
    }
  }
  assert.equal(failures.length, 0, failures.join(' | '));
}

for (const criterion of criteria) {
  let context;
  try {
    if (setupError) throw new Error(setupError);
    try {
      context = await browser.newContext();
    } catch (error) {
      throw new Error(`HARNESS: cannot create browser context: ${error.message}`);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    page.setDefaultNavigationTimeout(10000);
    const signIn = await navigate(page, '/auth/preview');
    assert.equal(signIn.status(), 200, `owner sign-in returned HTTP ${signIn.status()}`);
    assert.equal(new URL(page.url()).pathname, '/', 'owner sign-in did not redirect to /');

    if (criterion === 'AC1') await checkAddresses(page, ['invalid']);
    if (criterion === 'AC2') await checkAddresses(page, ['1.5']);
    if (criterion === 'AC3') await checkAddresses(page, ['-3']);
    if (criterion === 'AC4') await checkAddresses(page, malformed.slice(3));
    if (criterion === 'AC5') await checkAddresses(page, absent);
    if (criterion === 'AC6') await checkAddresses(page, [...malformed, ...absent], true);
    if (criterion === 'AC7') {
      await navigate(page, '/projects/demo');
      // Match T3 without a word boundary: nested key/title text may join as T3Demo….
      const links = page.getByRole('link').filter({ hasText: 'T3' });
      await links.first().waitFor({ state: 'visible' });
      let taskURL;
      for (let i = 0; i < await links.count(); i++) {
        const link = links.nth(i);
        if (!(await link.isVisible())) continue;
        const href = await link.getAttribute('href');
        if (!href) continue;
        const url = new URL(href, page.url());
        if (url.origin === baseURL.origin && /^\/tasks\/[0-9]+$/.test(url.pathname)) {
          taskURL = url.href;
          break;
        }
      }
      assert(taskURL, 'no visible T3 link to /tasks/{id}');
      // Follow the actual link destination as a document request to observe HTTP status,
      // independently of any client-side router's transport status.
      const response = await navigate(page, taskURL);
      assert.equal(response.status(), 200, `T3 returned HTTP ${response.status()}`);
      await evidence(page).waitFor({ state: 'visible' });
      assert.equal(await page.title(), 'Task · Agents', 'incorrect document title');
      const heading = page.getByRole('heading', { level: 1 }).filter({ hasText: 'T3' });
      await heading.first().waitFor({ state: 'visible' });
      await noVisible(page.getByText(notFound, { exact: true }), 'T3 shows Not found');
    }
    console.log(JSON.stringify({ criterion, result: 'pass' }));
  } catch (error) {
    console.log(JSON.stringify({ criterion, result: 'fail', detail: String(error.message).slice(0, 3500) }));
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
if (browser) await browser.close().catch(() => {});
process.exitCode = 0;
