import { Resend } from 'resend';
import { Application } from './types';
import { buildHtml, buildText, DigestOptions } from './template';

export async function sendDigest(
  applications: Application[],
  to: string | string[],
  from: string,
  periodLabel: string,
  apiKey: string,
  errors: { council: string; message: string }[] = [],
  priorities?: string[],
  webUrl?: string,
): Promise<void> {
  const resend = new Resend(apiKey);
  const opts: DigestOptions = { periodLabel, errors, priorities, webUrl };

  const subject = errors.length > 0
    ? `⚠️ Planning Digest (${errors.length} scraper failure${errors.length > 1 ? 's' : ''}) — ${periodLabel}`
    : `Planning Digest: ${applications.length} applications — ${periodLabel}`;

  const { error } = await resend.emails.send({
    from,
    to,
    subject,
    html: buildHtml(applications, opts),
    text: buildText(applications, opts),
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`Email sent to ${to}`);
}
