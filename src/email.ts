import { Resend } from 'resend';
import { Application, CouncilId } from './types';

const COUNCIL_NAMES: Record<CouncilId, string> = {
  TW: 'Tunbridge Wells',
  Sevenoaks: 'Sevenoaks',
  Wealden: 'Wealden',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildCouncilTable(apps: Application[]): string {
  if (apps.length === 0) return '<p style="color:#888;">No applications found in this period.</p>';

  const rows = apps
    .map(
      (a) => `
    <tr>
      <td style="padding:6px 8px;border:1px solid #ddd;white-space:nowrap;">
        <a href="${escapeHtml(a.detailsurl)}" style="color:#1a56db;">${escapeHtml(a.applreference)}</a>
      </td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${escapeHtml(a.address)}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${escapeHtml(a.description)}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;white-space:nowrap;">${escapeHtml(a.datevalidated ?? a.datereceived ?? '')}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;white-space:nowrap;">${escapeHtml(a.status ?? '')}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${escapeHtml(a.decision ?? '')}</td>
    </tr>`
    )
    .join('');

  return `
  <table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead>
      <tr style="background:#f3f4f6;">
        <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">Reference</th>
        <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">Address</th>
        <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">Description</th>
        <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">Validated</th>
        <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">Status</th>
        <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">Decision</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildErrorBanner(errors: { council: string; message: string }[]): string {
  if (errors.length === 0) return '';
  const rows = errors.map((e) => `
    <tr>
      <td style="padding:6px 8px;border:1px solid #fca5a5;font-weight:bold;">${escapeHtml(e.council)}</td>
      <td style="padding:6px 8px;border:1px solid #fca5a5;font-family:monospace;font-size:12px;">${escapeHtml(e.message)}</td>
    </tr>`).join('');
  return `
  <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:4px;padding:12px 16px;margin-bottom:24px;">
    <strong style="color:#b91c1c;">⚠️ ${errors.length} scraper${errors.length > 1 ? 's' : ''} failed — results below may be incomplete</strong>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px;">
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function buildHtml(applications: Application[], periodLabel: string, errors: { council: string; message: string }[] = []): string {
  const councils: CouncilId[] = ['TW', 'Sevenoaks', 'Wealden'];
  const total = applications.length;

  const sections = councils
    .map((id) => {
      const apps = applications.filter((a) => a.council === id);
      return `
      <h2 style="margin-top:32px;font-size:16px;color:#111827;">${COUNCIL_NAMES[id]} — ${apps.length} application${apps.length !== 1 ? 's' : ''}</h2>
      ${buildCouncilTable(apps)}`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;max-width:960px;margin:0 auto;padding:20px;color:#374151;">
  <h1 style="font-size:20px;border-bottom:2px solid #e5e7eb;padding-bottom:8px;">
    Planning Applications Digest — ${escapeHtml(periodLabel)}
  </h1>
  ${buildErrorBanner(errors)}
  <p style="color:#6b7280;font-size:13px;">
    <strong>${total}</strong> Full planning application${total !== 1 ? 's' : ''} validated across 3 councils.
  </p>
  ${sections}
  <hr style="margin-top:40px;border:none;border-top:1px solid #e5e7eb;">
  <p style="font-size:11px;color:#9ca3af;">
    Scraped from public planning portals. Links go directly to the council's planning system.
  </p>
</body>
</html>`;
}

function buildText(applications: Application[], periodLabel: string, errors: { council: string; message: string }[] = []): string {
  const councils: CouncilId[] = ['TW', 'Sevenoaks', 'Wealden'];
  const lines = [`Planning Applications Digest — ${periodLabel}`, ''];

  if (errors.length > 0) {
    lines.push(`⚠️  ${errors.length} scraper(s) failed — results may be incomplete`);
    for (const e of errors) lines.push(`  ${e.council}: ${e.message}`);
    lines.push('');
  }

  for (const id of councils) {
    const apps = applications.filter((a) => a.council === id);
    lines.push(`${COUNCIL_NAMES[id]} (${apps.length})`);
    lines.push('='.repeat(40));
    if (apps.length === 0) {
      lines.push('  No applications found.');
    } else {
      for (const a of apps) {
        lines.push(`  ${a.applreference}`);
        lines.push(`  ${a.address}`);
        lines.push(`  ${a.description}`);
        if (a.datevalidated) lines.push(`  Validated: ${a.datevalidated}`);
        if (a.status) lines.push(`  Status: ${a.status}`);
        if (a.decision) lines.push(`  Decision: ${a.decision}`);
        lines.push(`  ${a.detailsurl}`);
        lines.push('');
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function sendDigest(
  applications: Application[],
  to: string | string[],
  from: string,
  periodLabel: string,
  apiKey: string,
  errors: { council: string; message: string }[] = []
): Promise<void> {
  const resend = new Resend(apiKey);

  const subject = errors.length > 0
    ? `⚠️ Planning Digest (${errors.length} scraper failure${errors.length > 1 ? 's' : ''}) — ${periodLabel}`
    : `Planning Digest: ${applications.length} applications — ${periodLabel}`;

  const { error } = await resend.emails.send({
    from,
    to,
    subject,
    html: buildHtml(applications, periodLabel, errors),
    text: buildText(applications, periodLabel, errors),
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  console.log(`Email sent to ${to}`);
}
