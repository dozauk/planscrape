import { Browser, Page } from 'playwright';
import { format, parse } from 'date-fns';
import { Application, CouncilId } from '../types';
import { attachDiagnosticListeners, saveDebugSnapshot } from '../debug';
import { DecidedApp } from '../db';

export interface IdoxConfig {
  council: CouncilId;
  baseUrl: string;
}

const MAX_PAGES = 20;

/**
 * Application type suffixes to include.
 * Idox uses codes appended to reference numbers e.g. 26/00419/FULL, 26/00105/PRIOR.
 * TW and Sevenoaks use different abbreviations for the same types (e.g. FULL vs FUL).
 * Excluded: TPO/TCA (trees), ADV/WTPO (advertisements/trees), NMA (non-material amendment),
 * HOUSE (householder minor works), LDCE/LDCP/LDCPR (lawful development), DETAIL (discharge of conditions).
 */
const INCLUDED_SUFFIXES = new Set([
  // TW codes
  'FULL', 'PRIOR', 'OUT', 'REM', 'MAJ', 'LBC', 'CAC', 'PIP',
  // Sevenoaks codes (Idox instance with different abbreviations)
  'FUL',  // full application (TW uses FULL)
  'PAC',  // prior approval commercial-to-resi
  'PAD',  // prior approval dwellinghouse enlargement
]);

/** Extract the type suffix from an Idox reference, e.g. "26/00419/FULL" → "FULL" */
function appTypeSuffix(ref: string): string {
  return ref.split('/').pop() ?? '';
}

/**
 * Parse an Idox date like "Mon 23 Feb 2026" → "2026-02-23"
 * Falls back gracefully on unknown formats.
 */
function parseIdoxDate(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  // "EEE dd MMM yyyy" e.g. "Mon 23 Feb 2026"
  try {
    return format(parse(s, 'EEE dd MMM yyyy', new Date()), 'yyyy-MM-dd');
  } catch { /* fall through */ }
  // dd/MM/yyyy fallback
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
 * Retries once on HTTP 429 with a longer backoff before giving up.
 */
async function fetchDetail(page: Page, url: string): Promise<DetailData> {
  const RETRY_DELAY_MS = 15_000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (resp?.status() === 429) {
        if (attempt < 2) {
          console.log(`  429 on detail page — waiting ${RETRY_DELAY_MS / 1000}s before retry`);
          await page.waitForTimeout(RETRY_DELAY_MS);
          continue;
        }
        return {};
      }
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
  return {};
}

/**
 * Parse all application items from the current #searchresults page.
 */
async function parseResultsPage(
  page: Page,
  baseUrl: string,
  council: CouncilId,
): Promise<Application[]> {
  const results: Application[] = [];
  const items = page.locator('#searchresults li.searchresult');
  const count = await items.count();

  for (let i = 0; i < count; i++) {
    const item = items.nth(i);

    const summaryLink = item.locator('a.summaryLink');
    const description = (await summaryLink.locator('.summaryLinkTextClamp').textContent() ?? '').trim()
      || (await summaryLink.textContent() ?? '').trim();

    const relHref = (await summaryLink.getAttribute('href') ?? '').trim();
    const detailsurl = relHref.startsWith('http')
      ? relHref
      : `${baseUrl.replace(/\/online-applications$/, '')}${relHref}`;

    const address = (await item.locator('p.address').textContent() ?? '').trim();
    const metaText = (await item.locator('p.metaInfo').textContent() ?? '').trim();

    const applreference = extractAfter(metaText, 'Ref. No:');
    const receivedRaw   = extractAfter(metaText, 'Received:');
    const validatedRaw  = extractAfter(metaText, 'Validated:');
    const status        = extractAfter(metaText, 'Status:') || undefined;

    const datereceived  = parseIdoxDate(receivedRaw);
    const datevalidated = parseIdoxDate(validatedRaw);

    if (applreference) {
      results.push({ council, applreference, address, description, datereceived, datevalidated, status, detailsurl });
    }
  }

  return results;
}

/**
 * Submit the weekly list form for a given week option value and list type,
 * then collect all paginated results.
 */
async function runWeeklyListSearch(
  page: Page,
  baseUrl: string,
  council: CouncilId,
  weekValue: string,
): Promise<Application[]> {
  const resp = await page.goto(
    `${baseUrl}/search.do?action=weeklyList&searchType=Application`,
    { waitUntil: 'domcontentloaded', timeout: 60000 },
  );
  console.log(`[${council}] Weekly list page: HTTP ${resp?.status() ?? '?'}  week="${weekValue}"`);

  // Select the requested week
  await page.selectOption('select[name="week"]', { value: weekValue });

  // Select "Decided in this week" radio
  await page.locator('input[name="dateType"][value="DC_Decided"]').check();

  // Submit and wait for results list, no-results indicator, or single-result redirect
  await page.click('input[value="Search"], button[type="submit"]');
  await page.waitForSelector('#searchresults, .noResults, .messagebox, #simpleDetailsTable', { timeout: 60000 });

  // Single-result redirect
  if ((await page.locator('#simpleDetailsTable').count()) > 0 &&
      (await page.locator('#searchresults').count()) === 0) {
    console.log(`[${council}] Week "${weekValue}": single result — extracting from detail page`);
    const app = await extractSingleResult(page, council);
    return app ? [app] : [];
  }

  // No results
  const noResultsEl = page.locator('.noResults, .messagebox');
  if (await noResultsEl.count() > 0) {
    const msg = (await noResultsEl.first().textContent() ?? '').toLowerCase();
    if (msg.includes('no result') || msg.includes('no match') || msg.includes('0 result')) {
      console.log(`[${council}] Week "${weekValue}": no results`);
      return [];
    }
  }

  const results: Application[] = [];
  let pageNum = 1;

  while (pageNum <= MAX_PAGES) {
    console.log(`[${council}] Week "${weekValue}": parsing results page ${pageNum}`);
    const pageResults = await parseResultsPage(page, baseUrl, council);
    results.push(...pageResults);

    const nextLink = page.locator('a.next').first();
    if (await nextLink.count() === 0) break;

    await nextLink.click();
    await page.waitForSelector('#searchresults li.searchresult', { timeout: 30000 });
    pageNum++;
  }

  return results;
}

export async function scrapeIdox(
  browser: Browser,
  config: IdoxConfig,
  daysBack = 14,
  knownDecisions?: Map<string, DecidedApp>,
): Promise<Application[]> {
  const { council, baseUrl } = config;
  const today = new Date();

  console.log(`[${council}] Starting Idox scrape (weekly-list strategy) on ${baseUrl}`);
  console.log(`[${council}] Searching decision dates ~ last ${daysBack} days`);
  console.log(`[${council}] Included types: ${[...INCLUDED_SUFFIXES].join(', ')}`);
  if (knownDecisions) {
    console.log(`[${council}] DB cache: ${knownDecisions.size} already-decided application(s) — detail pages skipped for these`);
  }

  const page = await browser.newPage();
  attachDiagnosticListeners(page, council);

  try {
    // Determine which weeks to fetch. We always include the current week.
    // If daysBack > 7, also include the previous week to ensure full coverage
    // across the weekly boundary (e.g. on a Monday when this week has no decisions yet).
    await page.goto(
      `${baseUrl}/search.do?action=weeklyList&searchType=Application`,
      { waitUntil: 'domcontentloaded', timeout: 60000 },
    );

    const weekOptions: string[] = await page.evaluate((days) => {
      const sel = document.querySelector('select[name="week"]') as HTMLSelectElement;
      if (!sel) return [];
      const weeksNeeded = Math.ceil(days / 7);
      return Array.from(sel.options).slice(0, weeksNeeded).map(o => o.value);
    }, daysBack);

    console.log(`[${council}] Fetching weeks: ${weekOptions.join(', ')}`);

    // Collect results across all required weeks, deduplicating by reference
    const seen = new Set<string>();
    const all: Application[] = [];

    for (const weekValue of weekOptions) {
      const weekResults = await runWeeklyListSearch(page, baseUrl, council, weekValue);
      for (const app of weekResults) {
        if (!seen.has(app.applreference)) {
          seen.add(app.applreference);
          all.push(app);
        }
      }
    }

    // Filter to relevant application types
    const relevant = all.filter((a) => INCLUDED_SUFFIXES.has(appTypeSuffix(a.applreference)));
    const excluded = all.length - relevant.length;
    if (excluded > 0) {
      console.log(`[${council}] Filtered out ${excluded} non-relevant type(s) (TPO, HOUSE, NMA, etc.) — ${relevant.length} remaining`);
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

    console.log(`[${council}] Detail pages: ${needsDetail.length} to fetch, ${fromCache.length} served from DB cache`);
    for (const app of needsDetail) {
      const detail = await fetchDetail(page, app.detailsurl);
      app.decision        = detail.decision;
      app.decision_date   = detail.decision_date;
      app.appeal_decision = detail.appeal_decision;
      app.appeal_date     = detail.appeal_date;
      await page.waitForTimeout(3000);
    }

    console.log(`[${council}] Found ${relevant.length} applications (${all.length} total before type filter)`);
    return relevant;
  } catch (err) {
    await saveDebugSnapshot(page, council, err);
    throw err;
  } finally {
    await page.close();
  }
}
