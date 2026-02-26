/**
 * Generate a local HTML/text preview of the weekly digest email without sending it.
 * Usage: npm run preview
 * Output: email-preview.html, email-preview.txt (gitignored)
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import { format, subDays } from 'date-fns';
import { writeFileSync } from 'fs';
import { getApplicationsForDigest } from './db';
import { isClassificationEnabled } from './classify';
import { buildHtml, buildText, DigestOptions } from './template';

const DAYS_BACK = 7;
const DB_PATH = process.env.DB_PATH ?? 'planscrape.db';

const db = new Database(DB_PATH, { readonly: true });
const today = new Date();
const from = subDays(today, DAYS_BACK);
const periodLabel = `${format(from, 'dd MMM yyyy')} – ${format(today, 'dd MMM yyyy')}`;
const priorities = isClassificationEnabled() ? ['high', 'medium'] : undefined;
const applications = getApplicationsForDigest(db, DAYS_BACK, priorities);
db.close();

const webUrl = process.env.PLANSCRAPE_URL ?? 'https://www.doza.org/planscrape';
const opts: DigestOptions = { periodLabel, priorities, webUrl };

writeFileSync('email-preview.html', buildHtml(applications, opts), 'utf8');
writeFileSync('email-preview.txt', buildText(applications, opts), 'utf8');

console.log(`Preview generated from ${DB_PATH} (${applications.length} applications, period: ${periodLabel})`);
console.log('  email-preview.html');
console.log('  email-preview.txt');
console.log('\n--- TEXT PREVIEW ---');
console.log(buildText(applications, opts));
