import { Browser, Page } from 'playwright';
import { format, subDays, parse } from 'date-fns';
import { Application } from '../types';
import { attachDiagnosticListeners, saveDebugSnapshot } from '../debug';
import { DecidedApp } from '../db';

const BASE_URL = 'https://planning.wealden.gov.uk';
const MAX_PAGES = 20;

/**
 * Application type suffixes to include.
 * Anything not in this set is skipped before AI classification and detail-page fetches.
 * Excluded examples: CD (condition discharge), AD (advertisement), N04/N56 (prior approval
 * notifications), TPO (tree preservation), OA (observation from another authority).
 */
const INCLUDED_TYPES = new Set(['F', 'PIP', 'MAJ', 'OUT', 'REM', 'LB', 'CON', 'DEM']);

/** Extract the type suffix from a Wealden reference, e.g. "WD/2026/0123/F" → "F" */
function appTypeSuffix(ref: string): string {
  return ref.split('/').pop() ?? '';
}

/**
 * Build the /Search/Standard URL for a decision date range.
 * Wealden's weekly list uses MM/DD/YYYY HH:MM:SS (US format), URL-encoded.
 */
function buildSearchUrl(from: Date, to: Date): string {
  const enc = (d: Date) => encodeURIComponent(format(d, 'MM/dd/yyyy') + ' 00:00:00');
  return `${BASE_URL}/Search/Standard?DateDeterminedFrom=${enc(from)}&DateDeterminedTo=${enc(to)}`;
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
  if (page.url().toLowerCase().includes('/disclaimer')) {
    console.log('[Wealden] Accepting disclaimer');
    await page.locator('button:has-text("Agree"), input[value="Agree"]').first().click();
    await page.waitForLoadState('domcontentloaded');
  }
}

async function parseResultsPage(page: Page): Promise<Application[]> {
  // Extract all row data in a single synchronous evaluate() call so that
  // AJAX DOM updates cannot race between individual async locator reads.
  const rawRows = await page.evaluate(() => {
    const out: Array<{
      applreference: string;
      relHref: string;
      address: string;
      description: string;
      datevalidatedRaw: string;
      decisionDateRaw: string;
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
        address:          cells[2].textContent?.trim() ?? '',
        description:      cells[3].textContent?.trim() ?? '',
        datevalidatedRaw: cells[4].textContent?.trim() ?? '',
        decisionDateRaw:  cells[5].textContent?.trim() ?? '',
        statusRaw:        cells[6].textContent?.trim() ?? '',
      });
    });
    return out;
  });

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
      decision_date: parseWealdenDate(raw['Decision Issued Date'] ?? raw['Decision Date'] ?? ''),
      appeal_decision: notNA(raw['Appeal Decision']),
      appeal_date: parseWealdenDate(raw['Appeal Decision Date'] ?? raw['Appeal Date'] ?? ''),
    };
  } catch {
    return {};
  }
}

export async function scrapeWealden(
  browser: Browser,
  daysBack = 14,
  knownDecisions?: Map<string, DecidedApp>,
): Promise<Application[]> {
  const today = new Date();
  const from = subDays(today, daysBack);

  console.log('[Wealden] Starting scrape (weekly-list strategy — all application types)');
  console.log(`[Wealden] Searching decision dates ${format(from, 'yyyy-MM-dd')} – ${format(today, 'yyyy-MM-dd')} (${daysBack} days)`);
  console.log(`[Wealden] Included types: ${[...INCLUDED_TYPES].join(', ')}`);
  if (knownDecisions) {
    console.log(`[Wealden] DB cache: ${knownDecisions.size} already-decided application(s) — detail pages skipped for these`);
  }

  const page = await browser.newPage();
  attachDiagnosticListeners(page, 'Wealden');

  try {
    // Navigate directly to the pre-parameterised search URL (same endpoint the weekly
    // list page uses — no form interaction required).
    const searchUrl = buildSearchUrl(from, today);
    const resp = await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log(`[Wealden] Search page: HTTP ${resp?.status() ?? '?'}  url=${page.url()}`);

    await acceptDisclaimer(page);

    // Wait for results table (or empty state)
    try {
      await page.waitForSelector('table.tblResults tbody tr, .no-results, .messagebox', { timeout: 30000 });
    } catch {
      console.log('[Wealden] No results table found — may be empty');
      return [];
    }

    if (await page.locator('table.tblResults tbody tr').count() === 0) {
      console.log('[Wealden] Results table empty');
      return [];
    }

    // Collect all pages
    const all: Application[] = [];
    let pageNum = 1;

    while (pageNum <= MAX_PAGES) {
      console.log(`[Wealden] Parsing results page ${pageNum}`);
      const pageResults = await parseResultsPage(page);
      all.push(...pageResults);

      // Pagination: same AJAX pager as the advanced search results.
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

    // Filter to relevant application types before any further processing.
    const relevant = all.filter((a) => INCLUDED_TYPES.has(appTypeSuffix(a.applreference)));
    const excluded = all.length - relevant.length;
    if (excluded > 0) {
      console.log(`[Wealden] Filtered out ${excluded} non-relevant type(s) (CD, AD, N04, etc.) — ${relevant.length} remaining`);
    }

    // Populate decisions: use DB cache where available; only fetch detail pages for new apps.
    const needsDetail = relevant.filter((a) => !knownDecisions?.has(a.applreference));
    const fromCache   = relevant.filter((a) =>  knownDecisions?.has(a.applreference));

    for (const app of fromCache) {
      const k = knownDecisions!.get(app.applreference)!;
      app.decision        = k.decision;
      app.decision_date   = k.decision_date   ?? undefined;
      app.appeal_decision = k.appeal_decision ?? undefined;
      app.appeal_date     = k.appeal_date     ?? undefined;
    }

    console.log(`[Wealden] Detail pages: ${needsDetail.length} to fetch, ${fromCache.length} served from DB cache`);
    for (const app of needsDetail) {
      const detail = await fetchDetail(page, app.detailsurl);
      app.decision        = detail.decision        ?? app.decision;
      app.decision_date   = detail.decision_date   ?? app.decision_date;
      app.appeal_decision = detail.appeal_decision ?? app.appeal_decision;
      app.appeal_date     = detail.appeal_date     ?? app.appeal_date;
    }

    console.log(`[Wealden] Found ${relevant.length} applications (${all.length} total before type filter)`);
    return relevant;
  } catch (err) {
    await saveDebugSnapshot(page, 'Wealden', err);
    throw err;
  } finally {
    await page.close();
  }
}
