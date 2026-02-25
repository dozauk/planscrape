import { Page } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Attach listeners that log request failures, browser console errors,
 * and any HTTP 4xx/5xx responses to stdout so they appear in CI logs.
 */
export function attachDiagnosticListeners(page: Page, label: string): void {
  page.on('requestfailed', (req) => {
    console.error(`[${label}] Request FAILED  ${req.failure()?.errorText ?? '?'} — ${req.url()}`);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.error(`[${label}] Browser ${msg.type()}: ${msg.text()}`);
    }
  });

  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      console.error(`[${label}] HTTP ${resp.status()} — ${resp.url()}`);
    }
  });
}

/**
 * Save a debug snapshot (screenshot + page HTML + metadata) to ./debug/<label>-<timestamp>/
 * Called on scraper error so the files can be uploaded as CI artifacts.
 */
export async function saveDebugSnapshot(page: Page, label: string, error: unknown): Promise<void> {
  const slug = label.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const dir = path.join(process.cwd(), 'debug', `${slug}-${Date.now()}`);

  try { await fs.mkdir(dir, { recursive: true }); }
  catch { console.error(`[debug] Could not create ${dir}`); return; }

  try {
    await page.screenshot({ path: path.join(dir, 'screenshot.png'), fullPage: true });
    console.error(`[debug:${label}] screenshot.png saved`);
  } catch (e) {
    console.error(`[debug:${label}] Screenshot failed: ${e}`);
  }

  try {
    const html = await page.content();
    await fs.writeFile(path.join(dir, 'page.html'), html);
    console.error(`[debug:${label}] page.html saved (${html.length} chars)`);
  } catch (e) {
    console.error(`[debug:${label}] page.html save failed: ${e}`);
  }

  try {
    const meta = {
      label,
      url: page.url(),
      title: await page.title().catch(() => 'unknown'),
      error: String(error),
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    console.error(`[debug:${label}] meta.json: url=${meta.url}  title="${meta.title}"  error=${meta.error}`);
  } catch { /* ignore */ }
}
