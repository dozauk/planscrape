import 'dotenv/config';
import { chromium } from 'playwright';
import { scrapeIdox } from './scrapers/idox';
import { scrapeWealden } from './scrapers/wealden';
import { openDb, upsertApplications, logScrapeRun } from './db';
import { generateHtml } from './generate';

const DAYS_BACK = 14;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 20_000;
const DB_PATH = 'planscrape.db';
const WEB_OUTPUT = 'web-output';

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  onRetry?: () => Promise<void>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[${label}] Retry attempt ${attempt}/${RETRY_ATTEMPTS} — restarting browser`);
        await onRetry?.();
      }
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`[${label}] Attempt ${attempt}/${RETRY_ATTEMPTS} failed: ${err}`);
      if (attempt < RETRY_ATTEMPTS) {
        console.log(`[${label}] Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const db = openDb(DB_PATH);

  let browser = await chromium.launch({ headless: true });
  const errors: { council: string; message: string }[] = [];

  const restartBrowser = async () => {
    await browser.close().catch(() => {});
    browser = await chromium.launch({ headless: true });
  };

  try {
    // Tunbridge Wells
    try {
      const tw = await withRetry('TW',
        () => scrapeIdox(browser, { council: 'TW', baseUrl: 'https://twbcpa.midkent.gov.uk/online-applications' }, DAYS_BACK),
        restartBrowser,
      );
      upsertApplications(db, tw);
      logScrapeRun(db, 'TW', true, tw.length, null);
      if (tw.length === 0) console.warn('[TW] Warning: scraper returned 0 results');
    } catch (err) {
      logScrapeRun(db, 'TW', false, null, String(err));
      console.error(`[TW] Failed after ${RETRY_ATTEMPTS} attempts:`, err);
      errors.push({ council: 'TW', message: String(err) });
    }

    // Sevenoaks
    try {
      const sev = await withRetry('Sevenoaks',
        () => scrapeIdox(browser, { council: 'Sevenoaks', baseUrl: 'https://pa.sevenoaks.gov.uk/online-applications' }, DAYS_BACK),
        restartBrowser,
      );
      upsertApplications(db, sev);
      logScrapeRun(db, 'Sevenoaks', true, sev.length, null);
      if (sev.length === 0) console.warn('[Sevenoaks] Warning: scraper returned 0 results');
    } catch (err) {
      logScrapeRun(db, 'Sevenoaks', false, null, String(err));
      console.error(`[Sevenoaks] Failed after ${RETRY_ATTEMPTS} attempts:`, err);
      errors.push({ council: 'Sevenoaks', message: String(err) });
    }

    // Wealden
    try {
      const wea = await withRetry('Wealden',
        () => scrapeWealden(browser, DAYS_BACK),
        restartBrowser,
      );
      upsertApplications(db, wea);
      logScrapeRun(db, 'Wealden', true, wea.length, null);
      if (wea.length === 0) console.warn('[Wealden] Warning: scraper returned 0 results');
    } catch (err) {
      logScrapeRun(db, 'Wealden', false, null, String(err));
      console.error(`[Wealden] Failed after ${RETRY_ATTEMPTS} attempts:`, err);
      errors.push({ council: 'Wealden', message: String(err) });
    }

  } finally {
    await browser.close();
    db.close();
  }

  // Generate static web page
  generateHtml(DB_PATH, WEB_OUTPUT);

  if (errors.length > 0) {
    console.error(`\n${errors.length} scraper(s) failed — exiting with error so CI notifies you.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
