import { Browser, Page } from 'playwright';
import { format, subDays, parse } from 'date-fns';
import { Application, CouncilId } from '../types';
import { attachDiagnosticListeners, saveDebugSnapshot } from '../debug';

export interface IdoxConfig {
  council: CouncilId;
  baseUrl: string;
}

const MAX_PAGES = 20;
const CASE_TYPES = ['Full Application', 'Permission in Principle'];

function formatDate(d: Date): string {
  return format(d, 'dd/MM/yyyy');
}

/**
 * Parse an Idox date like "Mon 23 Feb 2026" → "2026-02-23"
 * Falls back gracefully on unknown formats.
 */
function parseIdoxDate(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  try {
    return format(parse(s, 'EEE dd MMM yyyy', new Date()), 'yyyy-MM-dd');
  } catch { /* fall through */ }
  // Also handle dd/MM/yyyy just in case
  try {
    return format(parse(s, 'dd/MM/yyyy', new Date()), 'yyyy-MM-dd');
  } catch {
    return undefined;
  }
}

/**
 * Extract text after a label in a metaInfo paragraph.
 * e.g. extractAfter("Ref. No: 26/00395/FULL | ...", "Ref. No:") → "26/00395/FULL"
 */
function extractAfter(text: string, label: string): string {
  const idx = text.indexOf(label);
  if (idx === -1) return '';
  const after = text.slice(idx + label.length).trim();
  // Stop at the next "|" divider
  const pipe = after.indexOf('|');
  return (pipe === -1 ? after : after.slice(0, pipe)).trim();
}

/**
 * When Idox has exactly one result it skips the list and redirects straight to
 * the application detail page. Extract an Application from #simpleDetailsTable.
 */
async function extractSingleResult(page: Page, council: CouncilId): Promise<Application | undefined> {
  const detailsurl = page.url();
  const raw = await page.evaluate(() => {
    const rows: Record<string, string> = {};
    document.querySelectorAll('#simpleDetailsTable th[scope="row"]').forEach((th) => {
      const key = th.textContent?.trim() ?? '';
      const val = th.closest('tr')?.querySelector('td')?.textContent?.trim() ?? '';
      if (key) rows[key] = val;
    });
    return rows;
  });

  const ref = raw['Reference'];
  if (!ref) return undefined;

  const notAvail = (v: string | undefined) => (v && v !== 'Not Available' ? v : undefined);
  return {
    council,
    applreference: ref,
    address: raw['Address'] ?? '',
    description: raw['Proposal'] ?? '',
    datereceived: parseIdoxDate(raw['Application Received'] ?? ''),
    datevalidated: parseIdoxDate(raw['Application Validated'] ?? ''),
    status: notAvail(raw['Status']),
    decision: notAvail(raw['Decision']),
    decision_date: parseIdoxDate(
      raw['Decision Issued Date'] ?? raw['Decision Date'] ?? raw['Date Decision Issued'] ?? '',
    ),
    appeal_decision: notAvail(raw['Appeal Decision']),
    appeal_date: parseIdoxDate(raw['Appeal Decision Date'] ?? ''),
    detailsurl,
  };
}

interface DetailData {
  decision?: string;
  decision_date?: string;
  appeal_decision?: string;
  appeal_date?: string;
}

/**
 * Visit an Idox application detail page and extract decision + appeal fields.
 * Reads all #simpleDetailsTable rows in one evaluate() call to avoid stale DOM.
 */
async function fetchDetail(page: Page, url: string): Promise<DetailData> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const raw = await page.evaluate(() => {
      const rows: Record<string, string> = {};
      document.querySelectorAll('#simpleDetailsTable th[scope="row"]').forEach((th) => {
        const key = th.textContent?.trim() ?? '';
        const val = th.closest('tr')?.querySelector('td')?.textContent?.trim() ?? '';
        if (key && val && val !== 'Not Available') rows[key] = val;
      });
      return rows;
    });
    return {
      decision: raw['Decision'] || undefined,
      decision_date: parseIdoxDate(
        raw['Decision Issued Date'] ?? raw['Decision Date'] ?? raw['Date Decision Issued'] ?? '',
      ),
      appeal_decision: raw['Appeal Decision'] || undefined,
      appeal_date: parseIdoxDate(raw['Appeal Decision Date'] ?? ''),
    };
  } catch {
    return {};
  }
}

/**
 * Run one search (one case type) and return all paginated results.
 */
async function runSearch(
  page: Page,
  baseUrl: string,
  council: CouncilId,
  caseTypeLabel: string,
  from: Date,
  today: Date,
): Promise<Application[]> {
  const resp = await page.goto(`${baseUrl}/search.do?action=advanced&searchType=Application`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  console.log(`[${council}] "${caseTypeLabel}" search page: HTTP ${resp?.status() ?? '?'}  url=${page.url()}`);

  // Find the exact option label using a case-insensitive match — portals differ in capitalisation
  // e.g. TW: "Permission in Principle" vs Sevenoaks: "Permission In Principle"
  const exactLabel = await page.evaluate((label) => {
    const sel = document.querySelector('select[name="searchCriteria.caseType"]') as HTMLSelectElement | null;
    if (!sel) return null;
    const opt = Array.from(sel.options).find((o) => o.text.trim().toLowerCase() === label.toLowerCase());
    return opt ? opt.text.trim() : null;
  }, caseTypeLabel);

  if (!exactLabel) {
    console.log(`[${council}] "${caseTypeLabel}": option not available on this portal, skipping`);
    return [];
  }

  await page.selectOption('select[name="searchCriteria.caseType"]', { label: exactLabel });

  // Fill decision date range (dd/MM/yyyy)
  await page.fill('input[name="date(applicationDecisionStart)"]', formatDate(from));
  await page.fill('input[name="date(applicationDecisionEnd)"]', formatDate(today));

  // Submit and wait for results list, no-results indicator, or single-result detail redirect
  await page.click('input[value="Search"], button[type="submit"]');
  await page.waitForSelector('#searchresults, .noResults, .messagebox, #simpleDetailsTable', { timeout: 60000 });

  // Idox redirects directly to the detail page when there is exactly one result
  if ((await page.locator('#simpleDetailsTable').count()) > 0 &&
      (await page.locator('#searchresults').count()) === 0) {
    console.log(`[${council}] "${caseTypeLabel}": single result — extracting from detail page`);
    const app = await extractSingleResult(page, council);
    return app ? [app] : [];
  }

  const results: Application[] = [];
  let pageNum = 1;

  while (pageNum <= MAX_PAGES) {
    // Check for no-results message
    const noResultsEl = page.locator('.noResults, .messagebox');
    if (await noResultsEl.count() > 0) {
      const msg = (await noResultsEl.first().textContent() ?? '').toLowerCase();
      if (msg.includes('no result') || msg.includes('no match') || msg.includes('0 result')) {
        console.log(`[${council}] "${caseTypeLabel}": no results`);
        break;
      }
    }

    console.log(`[${council}] "${caseTypeLabel}": parsing results page ${pageNum}`);

    // Results are <li class="searchresult"> inside <ul id="searchresults">
    const items = page.locator('#searchresults li.searchresult');
    const count = await items.count();

    for (let i = 0; i < count; i++) {
      const item = items.nth(i);

      // Description is the link text inside the summary link
      const summaryLink = item.locator('a.summaryLink');
      const description = (await summaryLink.locator('.summaryLinkTextClamp').textContent() ?? '').trim()
        || (await summaryLink.textContent() ?? '').trim();

      // Detail URL
      const relHref = (await summaryLink.getAttribute('href') ?? '').trim();
      const detailsurl = relHref.startsWith('http') ? relHref : `${baseUrl.replace(/\/online-applications$/, '')}${relHref}`;

      // Address
      const address = (await item.locator('p.address').textContent() ?? '').trim();

      // Reference and dates are in p.metaInfo
      const metaText = (await item.locator('p.metaInfo').textContent() ?? '').trim();

      const applreference = extractAfter(metaText, 'Ref. No:');
      const receivedRaw = extractAfter(metaText, 'Received:');
      const validatedRaw = extractAfter(metaText, 'Validated:');
      const status = extractAfter(metaText, 'Status:') || undefined;

      const datereceived = parseIdoxDate(receivedRaw);
      const datevalidated = parseIdoxDate(validatedRaw);

      if (applreference) {
        results.push({ council, applreference, address, description, datereceived, datevalidated, status, detailsurl });
      }
    }

    // Pagination — Idox uses <a class="next">
    const nextLink = page.locator('a.next').first();
    if (await nextLink.count() === 0) break;

    await nextLink.click();
    // Wait for the results list to reload
    await page.waitForSelector('#searchresults li.searchresult', { timeout: 30000 });
    pageNum++;
  }

  return results;
}

export async function scrapeIdox(browser: Browser, config: IdoxConfig, daysBack = 7): Promise<Application[]> {
  const { council, baseUrl } = config;
  const today = new Date();
  const from = subDays(today, daysBack);

  console.log(`[${council}] Starting Idox scrape on ${baseUrl}`);
  const page = await browser.newPage();
  attachDiagnosticListeners(page, council);

  try {
    const all: Application[] = [];

    for (const caseType of CASE_TYPES) {
      const results = await runSearch(page, baseUrl, council, caseType, from, today);
      all.push(...results);
    }

    // Fetch decision + appeal fields from each application's detail page.
    // Small delay between requests to avoid 429 rate-limiting on some portals.
    console.log(`[${council}] Fetching details from ${all.length} detail pages`);
    for (const app of all) {
      const detail = await fetchDetail(page, app.detailsurl);
      app.decision = detail.decision;
      app.decision_date = detail.decision_date;
      app.appeal_decision = detail.appeal_decision;
      app.appeal_date = detail.appeal_date;
      await page.waitForTimeout(1500);
    }

    console.log(`[${council}] Found ${all.length} applications`);
    return all;
  } catch (err) {
    await saveDebugSnapshot(page, council, err);
    throw err;
  } finally {
    await page.close();
  }
}
