import 'dotenv/config';
import { chromium } from 'playwright';
import { format, subDays } from 'date-fns';
import { scrapeIdox } from './scrapers/idox';
import { scrapeWealden } from './scrapers/wealden';
import { sendDigest } from './email';
import { Application } from './types';

const DAYS_BACK = 7;
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 20_000;

/**
 * Run fn up to `attempts` times, waiting `delayMs` between failures.
 * Logs each attempt. Throws the last error if all attempts fail.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) console.log(`[${label}] Retry attempt ${attempt}/${RETRY_ATTEMPTS}`);
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
  const today = new Date();
  const from = subDays(today, DAYS_BACK);
  const periodLabel = `${format(from, 'dd MMM yyyy')} – ${format(today, 'dd MMM yyyy')}`;

  console.log(`\nPlanning digest scrape — ${periodLabel}\n`);

  const browser = await chromium.launch({ headless: true });
  const applications: Application[] = [];
  const errors: { council: string; message: string }[] = [];

  try {
    // Tunbridge Wells
    try {
      const tw = await withRetry('TW', () =>
        scrapeIdox(browser, { council: 'TW', baseUrl: 'https://twbcpa.midkent.gov.uk/online-applications' }, DAYS_BACK)
      );
      if (tw.length === 0) console.warn('[TW] Warning: scraper returned 0 results');
      applications.push(...tw);
    } catch (err) {
      console.error(`[TW] Failed after ${RETRY_ATTEMPTS} attempts:`, err);
      errors.push({ council: 'TW', message: String(err) });
    }

    // Sevenoaks
    try {
      const sev = await withRetry('Sevenoaks', () =>
        scrapeIdox(browser, { council: 'Sevenoaks', baseUrl: 'https://pa.sevenoaks.gov.uk/online-applications' }, DAYS_BACK)
      );
      if (sev.length === 0) console.warn('[Sevenoaks] Warning: scraper returned 0 results');
      applications.push(...sev);
    } catch (err) {
      console.error(`[Sevenoaks] Failed after ${RETRY_ATTEMPTS} attempts:`, err);
      errors.push({ council: 'Sevenoaks', message: String(err) });
    }

    // Wealden
    try {
      const wea = await withRetry('Wealden', () => scrapeWealden(browser, DAYS_BACK));
      if (wea.length === 0) console.warn('[Wealden] Warning: scraper returned 0 results');
      applications.push(...wea);
    } catch (err) {
      console.error(`[Wealden] Failed after ${RETRY_ATTEMPTS} attempts:`, err);
      errors.push({ council: 'Wealden', message: String(err) });
    }

  } finally {
    await browser.close();
  }

  // Output JSON
  const output = { applications };
  console.log('\n--- JSON OUTPUT ---');
  console.log(JSON.stringify(output, null, 2));
  console.log(`--- Total: ${applications.length} applications ---\n`);

  // Send email if configured
  const apiKey = process.env.RESEND_API_KEY;
  const emailTo = process.env.EMAIL_TO?.split(',').map((s) => s.trim()).filter(Boolean);
  const emailFrom = process.env.EMAIL_FROM ?? 'onboarding@resend.dev';

  if (apiKey && emailTo) {
    console.log(`Sending digest to ${emailTo}...`);
    await sendDigest(applications, emailTo, emailFrom, periodLabel, apiKey, errors);
  } else {
    console.log('No RESEND_API_KEY / EMAIL_TO set — skipping email send.');
  }

  // Non-zero exit triggers GitHub Actions failure notification
  if (errors.length > 0) {
    console.error(`\n${errors.length} scraper(s) failed — exiting with error so CI notifies you.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
