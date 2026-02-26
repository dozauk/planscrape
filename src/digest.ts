/**
 * Weekly email digest entry point.
 * Reads from planscrape.db (downloaded as an artifact before this runs)
 * and sends a digest of applications decided/appealed in the last 7 days.
 * When AI classification is active (ANTHROPIC_API_KEY set), only high and
 * medium priority applications are included.
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { sendDigest } from './email';
import { getApplicationsForDigest } from './db';
import { isClassificationEnabled } from './classify';

const DAYS_BACK = 7;
const DB_PATH = 'planscrape.db';

async function main(): Promise<void> {
  const today = new Date();
  const from = subDays(today, DAYS_BACK);
  const periodLabel = `${format(from, 'dd MMM yyyy')} – ${format(today, 'dd MMM yyyy')}`;

  // When classification is active, restrict the digest to actionable leads only
  const priorities = isClassificationEnabled() ? ['high', 'medium'] : undefined;

  const db = new Database(DB_PATH, { readonly: true });
  const applications = getApplicationsForDigest(db, DAYS_BACK, priorities);
  db.close();

  const filterNote = priorities ? ` (priority: ${priorities.join('/')})` : '';
  console.log(`Digest: ${applications.length} applications in ${periodLabel}${filterNote}`);

  const apiKey = process.env.RESEND_API_KEY;
  const emailTo = process.env.EMAIL_TO?.split(',').map((s) => s.trim()).filter(Boolean);
  const emailFrom = process.env.EMAIL_FROM ?? 'onboarding@resend.dev';

  if (!apiKey || !emailTo?.length) {
    console.log('No RESEND_API_KEY / EMAIL_TO set — skipping email send.');
    return;
  }

  await sendDigest(applications, emailTo, emailFrom, periodLabel, apiKey, [], priorities);
  console.log(`Digest sent to ${emailTo}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
