import assert from 'node:assert/strict';

const ids = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'];
// Both sources are supplied by the gate; no private fixture environment is used.
const base = process.argv[2] || process.env.BASE_URL;
let browser, context, page, setupError;
try {
  if (!base) throw new Error('Missing baseURL argument and BASE_URL');
  new URL(base);
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  context = await browser.newContext();
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(25000);
} catch (error) {
  setupError = `HARNESS: ${error.message}`;
}

// Read DOM wording, never CSS-transformed innerText. Each element is read
// separately; structured rows are not concatenated for textual assertions.
async function fields(locator) {
  return locator.evaluate(root => {
    const visible = el => {
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
        style.display !== 'none' && el.getClientRects().length > 0;
    };
    return [root, ...root.querySelectorAll('*')].filter(visible).map(el => ({
      tag: el.tagName,
      text: (el.textContent || '').trim(),
      leaf: ![...el.children].some(visible),
    }));
  });
}
async function exactField(row, expected) {
  assert((await fields(row)).some(f => f.text === expected), `Missing visible field: ${expected}`);
}
async function openDecisions() {
  const response = await page.goto(new URL('/decisions', base).href, { waitUntil: 'networkidle' });
  assert.equal(response?.status(), 200, '/decisions must return HTTP 200');
  await page.getByRole('heading', { name: 'Decisions', exact: true }).waitFor({ state: 'visible' });
  await page.getByText('Open', { exact: true }).waitFor({ state: 'visible' });
}
async function decision(key, kind) {
  // Start from semantic list items, then inspect individual metadata fields.
  const candidates = page.getByRole('listitem');
  await candidates.first().waitFor({ state: 'visible' });
  const matches = [];
  for (let i = 0; i < await candidates.count(); i++) {
    const row = candidates.nth(i);
    if (!await row.isVisible()) continue;
    const fs = await fields(row);
    const meta = fs.filter(f => {
      const parts = f.text.split('·').map(s => s.trim());
      return parts.length === 3 && parts[0] === 'Demo Project' && parts[1] === key && parts[2].length > 0;
    });
    if (!meta.length || !fs.some(f => f.text === kind)) continue;
    // The nearest enclosing section/card with an Open label must contain this row.
    const inOpen = await row.evaluate(el => {
      for (let parent = el.parentElement; parent && parent.tagName !== 'BODY'; parent = parent.parentElement) {
        const labels = [...parent.querySelectorAll('*')].filter(n =>
          (n.textContent || '').trim() === 'Open' && n.getClientRects().length > 0);
        if (labels.length) return true;
      }
      return false;
    });
    if (inOpen) matches.push(row);
  }
  assert.equal(matches.length, 1, `Expected one ${kind} item for Demo Project · ${key} in Open`);
  return matches[0];
}
async function statements(row, expected) {
  const fs = await fields(row);
  assert(fs.some(f => f.text === expected), `Missing exact statement: ${expected}`);
  const counts = fs.map(f => f.text).filter(t => /^\d+ items? would be accepted without proof$/.test(t));
  if (expected === 'Nothing is accepted without proof') {
    assert.equal(counts.length, 0, 'Clean decision displays a numeric count');
  } else {
    assert(!fs.some(f => f.text === 'Nothing is accepted without proof'), 'Review decision displays clean statement');
    assert(counts.every(t => t === expected), 'Decision displays a contradictory count');
  }
}
async function taskLinks(row) {
  const links = row.getByRole('link');
  const result = [];
  for (let i = 0; i < await links.count(); i++) {
    const link = links.nth(i);
    const href = await link.getAttribute('href');
    if (!href) continue;
    const url = new URL(href, base);
    if (url.origin === new URL(base).origin && /^\/tasks\/[^/]+\/?$/.test(url.pathname)) result.push({ link, url });
  }
  assert.equal(result.length, 1, 'Expected exactly one link to /tasks/{id}');
  return result[0];
}
async function snapshot(row, key) {
  assert.equal(await row.locator('button, [role="button"], form, input:not([type="hidden"]), textarea, select, [role="textbox"], [role="combobox"]').count(), 0,
    `${key} acceptance item contains an editing control`);
  // Retain separate visible text nodes, including direct text beside child nodes.
  // Normalize only the age portion of the contracted metadata element.
  return row.evaluate((root, taskKey) => {
    const visible = el => el.getClientRects().length > 0 && !['hidden', 'collapse'].includes(getComputedStyle(el).visibility);
    const metadata = [...root.querySelectorAll('*')].filter(el => {
      const p = (el.textContent || '').trim().split('·').map(s => s.trim());
      return p.length === 3 && p[0] === 'Demo Project' && p[1] === taskKey;
    });
    const smallest = metadata.filter(el => !metadata.some(other => other !== el && el.contains(other)));
    const output = [];
    function walk(el) {
      if (!visible(el)) return;
      if (smallest.includes(el)) { output.push(`Demo Project · ${taskKey} · <age>`); return; }
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const value = child.textContent.replace(/\s+/g, ' ').trim();
          if (value) output.push(value);
        } else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
      }
    }
    walk(root);
    return output;
  }, key);
}

const checks = {
  AC1: async () => {
    await openDecisions();
    await statements(await decision('T4', 'Acceptance'), '2 items would be accepted without proof');
  },
  AC2: async () => {
    await openDecisions();
    await statements(await decision('T5', 'Acceptance'), 'Nothing is accepted without proof');
  },
  AC3: async () => {
    for (const [key, title] of [['T4', 'Demo: share a list'], ['T5', 'Demo: book covers']]) {
      await openDecisions();
      const { link, url } = await taskLinks(await decision(key, 'Acceptance'));
      assert.equal((await link.textContent()).trim().replace(/\s*·\s*/g, ' · '), `${key} · ${title}`, 'Task link text differs');
      const [response] = await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        link.click(),
      ]);
      // Client-side history navigation has no document response in Playwright.
      // In that case independently verify the linked route with this owner's cookies.
      const taskResponse = response ?? await context.request.get(url.href, { timeout: 25000 });
      assert.equal(taskResponse.status(), 200, 'Task navigation must return HTTP 200');
      assert.equal(new URL(page.url()).pathname.replace(/\/$/, ''), url.pathname.replace(/\/$/, ''), 'Task link opened a different route');
      await page.waitForFunction(() => document.title === 'Task · Agents');
      assert.equal(await page.title(), 'Task · Agents');
      await page.getByText(title, { exact: true }).first().waitFor({ state: 'visible' });
      await page.getByText(key, { exact: true }).first().waitFor({ state: 'visible' });
    }
  },
  AC4: async () => {
    await openDecisions();
    const before = {};
    for (const key of ['T4', 'T5']) before[key] = await snapshot(await decision(key, 'Acceptance'), key);
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Decisions', exact: true }).waitFor({ state: 'visible' });
    for (const key of ['T4', 'T5']) assert.deepEqual(await snapshot(await decision(key, 'Acceptance'), key), before[key], `${key} changed after reload (excluding age)`);
  },
  AC5: async () => {
    // The frozen inputs do not supply the historical title/explanation fixtures.
    // Check all independently specified consequences before reporting that gap;
    // observing this build cannot establish its own unchanged-wording baseline.
    await openDecisions();
    for (const [key, kind] of [['T1', 'Contract review'], ['T2', 'Decision']]) {
      const row = await decision(key, kind);
      await exactField(row, kind);
      assert.equal(await row.getByRole('link').count(), 1, `${key} must contain exactly one link`);
      await taskLinks(row);
      const fs = await fields(row);
      assert(!fs.some(f => /would be accepted without proof|Nothing is accepted without proof/i.test(f.text)), `${key} contains acceptance wording`);
      if (key === 'T1') await exactField(row, 'Approve the contract for T1: Demo: export a list as CSV');
    }
    throw new Error('HARNESS: Missing authoritative pre-T9 fixtures: T2 decision title, T0 title-shortening rule, and T1/T2 explanation text. Supply the referenced accepted contracts/checks or their frozen fixtures; this build cannot establish its own unchanged-wording baseline. See NOTES.md.');
  },
};

try {
  for (const criterion of ids) {
    try {
      if (setupError) throw new Error(setupError);
      // Reestablish the documented owner session for each independent criterion.
      await page.goto(new URL('/auth/preview', base).href, { waitUntil: 'networkidle' });
      assert.equal(new URL(page.url()).pathname, '/', 'Preview sign-in did not redirect to /');
      await checks[criterion]();
      console.log(JSON.stringify({ criterion, result: 'pass' }));
    } catch (error) {
      console.log(JSON.stringify({ criterion, result: 'fail', detail: String(error.message || error).slice(0, 1200) }));
    }
  }
} finally {
  await browser?.close().catch(() => {});
}
