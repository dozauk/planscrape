import { Browser, Page } from 'playwright';
import { format, subDays, parse } from 'date-fns';
import { Application, CouncilId } from '../types';

export interface IdoxConfig {
  council: CouncilId;
  baseUrl: string;
}

const MAX_PAGES = 20;

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
 * Visit an Idox application detail page and extract the Decision field value.
 * Returns undefined if the Decision row is absent or contains "Not Available".
 */
async function fetchDecision(page: Page, url: string): Promise<string | undefined> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('#simpleDetailsTable th[scope="row"]'));
      for (const th of ths) {
        if (th.textContent?.trim() === 'Decision') {
          const text = th.closest('tr')?.querySelector('td')?.textContent?.trim();
          return text && text !== 'Not Available' ? text : undefined;
        }
      }
      return undefined;
    });
  } catch {
    return undefined;
  }
}

export async function scrapeIdox(browser: Browser, config: IdoxConfig, daysBack = 7): Promise<Application[]> {
  const { council, baseUrl } = config;
  const today = new Date();
  const from = subDays(today, daysBack);

  console.log(`[${council}] Starting Idox scrape on ${baseUrl}`);
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/search.do?action=advanced&searchType=Application`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Select "Full Application" by label text
    await page.selectOption('select[name="searchCriteria.caseType"]', { label: 'Full Application' });

    // Fill decision date range (dd/MM/yyyy)
    await page.fill('input[name="date(applicationDecisionStart)"]', formatDate(from));
    await page.fill('input[name="date(applicationDecisionEnd)"]', formatDate(today));

    // Submit and wait for results list or a no-results indicator
    await page.click('input[value="Search"], button[type="submit"]');
    await page.waitForSelector('#searchresults, .noResults, .messagebox', { timeout: 30000 });

    const all: Application[] = [];
    let pageNum = 1;

    while (pageNum <= MAX_PAGES) {
      // Check for no-results message
      const noResultsEl = page.locator('.noResults, .messagebox');
      if (await noResultsEl.count() > 0) {
        const msg = (await noResultsEl.first().textContent() ?? '').toLowerCase();
        if (msg.includes('no result') || msg.includes('no match') || msg.includes('0 result')) {
          console.log(`[${council}] No results found`);
          break;
        }
      }

      console.log(`[${council}] Parsing results page ${pageNum}`);

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
          all.push({ council, applreference, address, description, datereceived, datevalidated, status, detailsurl });
        }
      }

      // Pagination — Idox uses <a class="next">
      const nextLink = page.locator('a.next').first();
      if (await nextLink.count() === 0) break;

      await nextLink.click();
      // Wait for the results list to reload
      await page.waitForSelector('#searchresults li.searchresult', { timeout: 20000 });
      pageNum++;
    }

    // Fetch decision from each application's detail page
    console.log(`[${council}] Fetching decisions from ${all.length} detail pages`);
    for (const app of all) {
      app.decision = await fetchDecision(page, app.detailsurl);
    }

    console.log(`[${council}] Found ${all.length} applications`);
    return all;
  } finally {
    await page.close();
  }
}
