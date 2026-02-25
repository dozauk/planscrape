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
      dateRaw: string;
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
        dateRaw: cells[4].textContent?.trim() ?? '',
        statusRaw: cells[6].textContent?.trim() ?? '',
      });
    });
    return out;
  }, BASE_URL);

  return rawRows.map(({ applreference, relHref, address, description, dateRaw, statusRaw }) => ({
    council: 'Wealden' as const,
    applreference,
    address,
    description,
    datevalidated: parseWealdenDate(dateRaw),
    status: statusRaw && statusRaw !== '-' ? statusRaw : undefined,
    detailsurl: relHref.startsWith('http') ? relHref : `${BASE_URL}${relHref}`,
  }));
}

/**
 * Visit a Wealden application detail page and extract the Decision field value.
 * Returns undefined if Decision is absent, blank, or "N/A".
 */
async function fetchDecision(page: Page, url: string): Promise<string | undefined> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return await page.evaluate(() => {
      const tds = Array.from(document.querySelectorAll('#summarytable td[role="rowheader"]'));
      for (const td of tds) {
        if (td.querySelector('strong')?.textContent?.trim() === 'Decision') {
          const text = td.closest('tr')?.querySelector('td.text-character-wrap')?.textContent?.trim();
          return text && text !== 'N/A' ? text : undefined;
        }
      }
      return undefined;
    });
  } catch {
    return undefined;
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

      // Pagination uses AJAX — look for "Next Page." link
      const nextLink = page.locator('ul.ajax-pager a[aria-label="Next Page."]');
      if (await nextLink.count() === 0) break;

      await nextLink.click();
      // Wait for AJAX to complete and update the results container
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      // Confirm table is still present after AJAX update
      await page.waitForSelector('table.tblResults tbody tr', { timeout: 10000 });
      pageNum++;
    }

    // Fetch decision from each application's detail page
    console.log(`[Wealden] Fetching decisions from ${all.length} detail pages`);
    for (const app of all) {
      app.decision = await fetchDecision(page, app.detailsurl);
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
