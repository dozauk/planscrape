import { Application, CouncilId } from './types';

export const COUNCIL_NAMES: Record<CouncilId, string> = {
  TW: 'Tunbridge Wells',
  Sevenoaks: 'Sevenoaks',
  Wealden: 'Wealden',
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isApproved(decision: string | null | undefined): boolean {
  if (!decision) return false;
  const v = decision.toLowerCase();
  return v.includes('permit') || v.includes('grant') || v.includes('approv') || v.includes('allow');
}

function decisionStyle(decision: string | null | undefined): string {
  if (!decision) return 'color:#374151;';
  const v = decision.toLowerCase();
  if (v.includes('permit') || v.includes('grant') || v.includes('approv') || v.includes('allow'))
    return 'color:#065f46;font-weight:500;';
  if (v.includes('refus') || v.includes('dismiss'))
    return 'color:#991b1b;font-weight:500;';
  if (v.includes('withdraw'))
    return 'color:#92400e;';
  return 'color:#374151;';
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };

function priorityRank(p: string | null | undefined): number {
  return PRIORITY_ORDER[p ?? ''] ?? 4;
}

function decisionRank(d: string | null | undefined): number {
  if (!d) return 3;
  const v = d.toLowerCase();
  if (v.includes('permit') || v.includes('grant') || v.includes('approv') || v.includes('allow')) return 0;
  if (v.includes('refus') || v.includes('dismiss')) return 1;
  if (v.includes('withdraw')) return 2;
  return 3;
}

function sortApps(apps: Application[]): Application[] {
  return [...apps].sort((a, b) => {
    const pd = priorityRank(a.priority) - priorityRank(b.priority);
    if (pd !== 0) return pd;
    return decisionRank(a.decision) - decisionRank(b.decision);
  });
}

function priorityBadge(priority: string | null | undefined): string {
  if (!priority) return '';
  const styles: Record<string, string> = {
    high:   'background:#d1fae5;color:#065f46;font-weight:bold;',
    medium: 'background:#fef3c7;color:#92400e;font-weight:bold;',
    low:    'background:#f3f4f6;color:#6b7280;',
    none:   'background:#f3f4f6;color:#9ca3af;',
  };
  const style = styles[priority] ?? '';
  const label = priority.charAt(0).toUpperCase() + priority.slice(1);
  return `<span style="padding:1px 7px;border-radius:10px;font-size:11px;${style}">${label}</span>`;
}

function buildCouncilTable(apps: Application[]): string {
  if (apps.length === 0) return '<p style="color:#888;">No applications found in this period.</p>';

  const rows = sortApps(apps)
    .map(
      (a) => `
    <tr>
      <td style="padding:6px 8px;border:1px solid #ddd;white-space:nowrap;">
        <a href="${escapeHtml(a.detailsurl)}" style="color:#1a56db;">${escapeHtml(a.applreference)}</a>
      </td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${escapeHtml(a.address)}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${escapeHtml(a.description)}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;white-space:nowrap;">${escapeHtml(a.decision_date ?? '')}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${priorityBadge(a.priority)}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;${decisionStyle(a.decision)}">${escapeHtml(a.decision ?? '')}</td>
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
        <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">Decision Date</th>
        <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">Priority</th>
        <th style="padding:6px 8px;border:1px solid #ddd;text-align:left;">Decision</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildLeadsSummary(applications: Application[]): string {
  const leads = applications.filter((a) => a.priority === 'high' && isApproved(a.decision));
  if (leads.length === 0) return '';
  const rows = leads.map((a) => `
    <tr>
      <td style="padding:6px 8px;border:1px solid #6ee7b7;white-space:nowrap;">
        <a href="${escapeHtml(a.detailsurl)}" style="color:#065f46;font-weight:600;">${escapeHtml(a.applreference)}</a>
      </td>
      <td style="padding:6px 8px;border:1px solid #6ee7b7;white-space:nowrap;">${escapeHtml(a.council)}</td>
      <td style="padding:6px 8px;border:1px solid #6ee7b7;">${escapeHtml(a.address)}</td>
      <td style="padding:6px 8px;border:1px solid #6ee7b7;">${escapeHtml(a.description)}</td>
      <td style="padding:6px 8px;border:1px solid #6ee7b7;white-space:nowrap;">${escapeHtml(a.decision ?? '')}</td>
    </tr>`).join('');
  return `
  <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:4px;padding:12px 16px;margin-bottom:24px;">
    <strong style="color:#065f46;font-size:14px;">
      ${leads.length} high-priority approved application${leads.length !== 1 ? 's' : ''} this period
    </strong>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-top:8px;">
      <thead>
        <tr style="background:#a7f3d0;">
          <th style="padding:5px 8px;border:1px solid #6ee7b7;text-align:left;">Reference</th>
          <th style="padding:5px 8px;border:1px solid #6ee7b7;text-align:left;">Council</th>
          <th style="padding:5px 8px;border:1px solid #6ee7b7;text-align:left;">Address</th>
          <th style="padding:5px 8px;border:1px solid #6ee7b7;text-align:left;">Description</th>
          <th style="padding:5px 8px;border:1px solid #6ee7b7;text-align:left;">Decision</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
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

export interface DigestOptions {
  periodLabel: string;
  errors?: { council: string; message: string }[];
  priorities?: string[];
  webUrl?: string;
}

export function buildHtml(applications: Application[], opts: DigestOptions): string {
  const { periodLabel, errors = [], priorities, webUrl } = opts;
  const councils: CouncilId[] = ['TW', 'Sevenoaks', 'Wealden'];
  const total = applications.length;
  const filterNote = priorities
    ? ` <span style="font-size:12px;color:#6b7280;font-weight:normal;">(${priorities.join(' &amp; ')} priority leads only)</span>`
    : '';

  const webLink = webUrl
    ? `<p style="font-size:13px;margin-bottom:4px;">
    View full dashboard: <a href="${escapeHtml(webUrl)}" style="color:#1a56db;">${escapeHtml(webUrl)}</a>
  </p>`
    : '';

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
    Planning Applications Digest — ${escapeHtml(periodLabel)}${filterNote}
  </h1>
  ${webLink}
  ${buildErrorBanner(errors)}
  ${buildLeadsSummary(applications)}
  <p style="color:#6b7280;font-size:13px;">
    <strong>${total}</strong> application${total !== 1 ? 's' : ''} across 3 councils.
  </p>
  ${sections}
  <hr style="margin-top:40px;border:none;border-top:1px solid #e5e7eb;">
  <p style="font-size:11px;color:#9ca3af;">
    Scraped from public planning portals. Links go directly to the council's planning system.
  </p>
</body>
</html>`;
}

export function buildText(applications: Application[], opts: DigestOptions): string {
  const { periodLabel, errors = [], priorities, webUrl } = opts;
  const councils: CouncilId[] = ['TW', 'Sevenoaks', 'Wealden'];
  const filterNote = priorities ? ` [${priorities.join('/')} priority only]` : '';
  const lines = [`Planning Applications Digest — ${periodLabel}${filterNote}`, ''];

  if (webUrl) {
    lines.push(`Full dashboard: ${webUrl}`);
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push(`⚠️  ${errors.length} scraper(s) failed — results may be incomplete`);
    for (const e of errors) lines.push(`  ${e.council}: ${e.message}`);
    lines.push('');
  }

  const leads = applications.filter((a) => a.priority === 'high' && isApproved(a.decision));
  if (leads.length > 0) {
    lines.push(`★ ${leads.length} HIGH-PRIORITY APPROVED LEAD${leads.length !== 1 ? 'S' : ''} THIS PERIOD`);
    lines.push('='.repeat(40));
    for (const a of leads) {
      lines.push(`  ${a.applreference} — ${a.council}`);
      lines.push(`  ${a.address}`);
      lines.push(`  ${a.description}`);
      lines.push(`  Decision: ${a.decision}`);
      lines.push(`  ${a.detailsurl}`);
      lines.push('');
    }
  }

  for (const id of councils) {
    const apps = sortApps(applications.filter((a) => a.council === id));
    lines.push(`${COUNCIL_NAMES[id]} (${apps.length})`);
    lines.push('='.repeat(40));
    if (apps.length === 0) {
      lines.push('  No applications found.');
    } else {
      for (const a of apps) {
        const pri = a.priority ? `[${a.priority.toUpperCase()}] ` : '';
        lines.push(`  ${pri}${a.applreference}`);
        lines.push(`  ${a.address}`);
        lines.push(`  ${a.description}`);
        if (a.priority_reason) lines.push(`  → ${a.priority_reason}`);
        if (a.decision_date) lines.push(`  Decided: ${a.decision_date}`);
        if (a.decision) lines.push(`  Decision: ${a.decision}`);
        lines.push(`  ${a.detailsurl}`);
        lines.push('');
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
