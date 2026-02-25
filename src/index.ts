import 'dotenv/config';
import { chromium } from 'playwright';
import { format, subDays } from 'date-fns';
import { scrapeIdox } from './scrapers/idox';
import { scrapeWealden } from './scrapers/wealden';
import { sendDigest } from './email';
import { Application } from './types';

const DAYS_BACK = 7;

async function main(): Promise<void> {
  const today = new Date();
  const from = subDays(today, DAYS_BACK);
  const periodLabel = `${format(from, 'dd MMM yyyy')} – ${format(today, 'dd MMM yyyy')}`;

  console.log(`\nPlanning digest scrape — ${periodLabel}\n`);

  const browser = await chromium.launch({ headless: true });
  const applications: Application[] = [];

  try {
    // Tunbridge Wells
    const tw = await scrapeIdox(browser, {
      council: 'TW',
      baseUrl: 'https://twbcpa.midkent.gov.uk/online-applications',
    }, DAYS_BACK);
    applications.push(...tw);

    // Sevenoaks
    const sev = await scrapeIdox(browser, {
      council: 'Sevenoaks',
      baseUrl: 'https://pa.sevenoaks.gov.uk/online-applications',
    }, DAYS_BACK);
    applications.push(...sev);

    // Wealden
    const wea = await scrapeWealden(browser, DAYS_BACK);
    applications.push(...wea);

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
  const emailTo = process.env.EMAIL_TO;
  const emailFrom = process.env.EMAIL_FROM ?? 'onboarding@resend.dev';

  if (apiKey && emailTo) {
    console.log(`Sending digest to ${emailTo}...`);
    await sendDigest(applications, emailTo, emailFrom, periodLabel, apiKey);
  } else {
    console.log('No RESEND_API_KEY / EMAIL_TO set — skipping email send.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
