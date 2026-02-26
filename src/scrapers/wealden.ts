import { Browser, Page } from 'playwright';
import { format, subDays, parse } from 'date-fns';
import { Application } from '../types';
import { attachDiagnosticListeners, saveDebugSnapshot } from '../debug';

const BASE_URL = 'https://planning.wealden.gov.uk';
const MAX_PAGES = 20;

function formatDate(d: Date): string {
  return format(d, 'dd/MM/yyyy');
}

function parseWealdenDate(raw: string): string | undefined {
  const s = raw.trim();
  if (!s || s === '-') return undefined;
  try {
    return format(parse(s, 'dd/MM/yyyy', new Date()), 'yyyy-MM-dd');
  } catch {
    return undefined;
  }
}

async function acceptDisclaimer(page: Page): Promise<void> {
  // Page redirects to /Disclaimer?returnUrl=... — click "Agree" to proceed
  if (page.url().includes('/Disclaimer')) {
    console.log('[Wealden] Accepting disclaimer');
    await page.locator('button:has-text("Agree"), input[value="Agree"]').first().click();
    await page.waitForLoadState('domcontentloaded');
  }
}

async function parseResultsPage(page: Page): Promise<Application[]> {
  // Extract all row data in a single synchronous evaluate() call so that
  // AJAX DOM updates cannot race between individual async locator reads.
  const rawRows = await page.evaluate((baseUrl) => {
    const out: Array<{
      applreference: string;
      relHref: string;
      address: string;
      description: string;
      datevalidatedRaw: string;
      decisionDateRaw: string;   // col 5 — decision date
      statusRaw: string;
    }> = [];
    document.querySelectorAll('table.tblResults tbody tr').forEach((row) => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 7) return;
      const link = cells[0].querySelector('a');
      if (!link) return;
      const applreference = link.textContent?.trim() ?? '';
      const relHref = link.getAttribute('href')?.trim() ?? '';
      if (!applreference || !relHref) return;
      out.push({
        applreference,
        relHref,
        address: cells[2].textContent?.trim() ?? '',
        description: cells[3].textContent?.trim() ?? '',
        datevalidatedRaw: cells[4].textContent?.trim() ?? '',
        decisionDateRaw:  cells[5].textContent?.trim() ?? '',
        statusRaw: cells[6].textContent?.trim() ?? '',
      });
    });
    return out;
  }, BASE_URL);

  return rawRows.map(({ applreference, relHref, address, description, datevalidatedRaw, decisionDateRaw, statusRaw }) => ({
    council: 'Wealden' as const,
    applreference,
    address,
    description,
    datevalidated: parseWealdenDate(datevalidatedRaw),
    decision_date: parseWealdenDate(decisionDateRaw),
    status: statusRaw && statusRaw !== '-' ? statusRaw : undefined,
    detailsurl: relHref.startsWith('http') ? relHref : `${BASE_URL}${relHref}`,
  }));
}

interface DetailData {
  decision?: string;
  decision_date?: string;
  appeal_decision?: string;
  appeal_date?: string;
}

/**
 * Visit a Wealden detail page and extract decision + appeal fields.
 * Returns raw date strings from the browser, then parses them in Node.js.
 */
async function fetchDetail(page: Page, url: string): Promise<DetailData> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const raw = await page.evaluate(() => {
      const rows: Record<string, string> = {};
      document.querySelectorAll('#summarytable tr').forEach((row) => {
        const label = row.querySelector('td[role="rowheader"] strong')?.textContent?.trim() ?? '';
        const val = row.querySelector('td.text-character-wrap')?.textContent?.trim() ?? '';
        if (label && val && val !== 'N/A') rows[label] = val;
      });
      return rows;
    });
    const notNA = (v: string | undefined) => (v && v !== 'N/A' ? v : undefined);
    return {
      decision: notNA(raw['Decision']),
      decision_date: parseWealdenDate(
        raw['Decision Issued Date'] ?? raw['Decision Date'] ?? '',
      ),
      appeal_decision: notNA(raw['Appeal Decision']),
      appeal_date: parseWealdenDate(raw['Appeal Decision Date'] ?? raw['Appeal Date'] ?? ''),
    };
  } catch {
    return {};
  }
}

export async function scrapeWealden(browser: Browser, daysBack = 7): Promise<Application[]> {
  const today = new Date();
  const from = subDays(today, daysBack);

  console.log('[Wealden] Starting scrape');
  const page = await browser.newPage();
  attachDiagnosticListeners(page, 'Wealden');

  try {
    const resp = await page.goto(`${BASE_URL}/Search/Advanced`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    console.log(`[Wealden] Search page: HTTP ${resp?.status() ?? '?'}  url=${page.url()}`);

    await acceptDisclaimer(page);

    // Click "Advanced" tab — the Quick tab is active by default
    const advTab = page.locator('a.tab-button:has-text("Advanced")');
    if (await advTab.count() > 0) {
      await advTab.click();
      // Small wait for tab JS to activate the panel
      await page.waitForTimeout(300);
    }

    // Set checkboxes via JS evaluation — they're CSS-hidden (custom styled with ea-triggers-bound)
    await page.evaluate(() => {
      const setChecked = (id: string, val: boolean) => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) {
          el.checked = val;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      setChecked('SearchPlanning', true);
      setChecked('SearchBuildingControl', false);
      setChecked('SearchEnforcement', false);
      setChecked('SearchTreePreservationOrders', false);
    });

    // Application type: Full = "F"
    await page.locator('#ApplicationType').selectOption({ value: 'F' });

    // Decision date range
    await page.locator('#DateDeterminedFrom').fill(formatDate(from));
    await page.locator('#DateDeterminedTo').fill(formatDate(today));

    // Submit using the button inside the #advanced tab pane
    await page.locator('#advanced button[type="submit"]').click();
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 });

    // Wait for results table
    try {
      await page.waitForSelector('table.tblResults tbody tr', { timeout: 30000 });
    } catch {
      console.log('[Wealden] No results table found — may be empty');
      return [];
    }

    const all: Application[] = [];
    let pageNum = 1;

    while (pageNum <= MAX_PAGES) {
      console.log(`[Wealden] Parsing results page ${pageNum}`);
      const pageResults = await parseResultsPage(page);
      all.push(...pageResults);

      // Pagination: the "Next Page" link uses AJAX and its DOM node is replaced
      // by the server before Playwright can click it (detached from DOM error).
      // Fix: fire the click via JS (no stability wait), then wait for the AJAX
      // response before reading the updated table.
      // Direct page.goto() doesn't work — Wealden requires server-side session.
      const nextLink = page.locator('ul.ajax-pager a[aria-label="Next Page."]');
      if (await nextLink.count() === 0) break;

      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/Search/ResultsPage') && r.status() < 400,
          { timeout: 15000 },
        ),
        page.evaluate(() => {
          const el = document.querySelector(
            'ul.ajax-pager a[aria-label="Next Page."]',
          ) as HTMLAnchorElement | null;
          el?.click();
        }),
      ]);
      await page.waitForSelector('table.tblResults tbody tr', { timeout: 10000 });
      pageNum++;
    }

    // Fetch decision + appeal fields from each application's detail page
    console.log(`[Wealden] Fetching details from ${all.length} detail pages`);
    for (const app of all) {
      const detail = await fetchDetail(page, app.detailsurl);
      // Prefer detail-page values where available; fall back to what the
      // results table already gave us (e.g. decision_date from col 5).
      app.decision        = detail.decision        ?? app.decision;
      app.decision_date   = detail.decision_date   ?? app.decision_date;
      app.appeal_decision = detail.appeal_decision ?? app.appeal_decision;
      app.appeal_date     = detail.appeal_date     ?? app.appeal_date;
    }

    console.log(`[Wealden] Found ${all.length} applications`);
    return all;
  } catch (err) {
    await saveDebugSnapshot(page, 'Wealden', err);
    throw err;
  } finally {
    await page.close();
  }
}
