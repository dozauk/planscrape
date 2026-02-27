import { chromium } from 'playwright';

// Quick suffix audit for both portals
const PORTALS = [
  { name: 'TW',        url: 'https://twbcpa.midkent.gov.uk/online-applications' },
  { name: 'Sevenoaks', url: 'https://pa.sevenoaks.gov.uk/online-applications' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  for (const { name, url } of PORTALS) {
    const page = await browser.newPage();
    await page.goto(`${url}/search.do?action=weeklyList&searchType=Application`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('input[name="dateType"][value="DC_Decided"]').check();
    await page.click('input[value="Search"], button[type="submit"]');
    await page.waitForSelector('#searchresults, .noResults', { timeout: 30000 });

    const refs: string[] = [];
    let pageNum = 1;
    while (pageNum <= 10) {
      const metaTexts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#searchresults li.searchresult p.metaInfo'))
          .map(p => p.textContent?.trim() ?? '')
      );
      for (const t of metaTexts) {
        const ref = t.split('Ref. No:')[1]?.split('|')[0]?.trim();
        if (ref) refs.push(ref);
      }
      const next = page.locator('a.next').first();
      if (await next.count() === 0) break;
      await next.click();
      await page.waitForSelector('#searchresults li.searchresult', { timeout: 15000 });
      pageNum++;
    }

    const bySuffix = refs.reduce((acc, r) => {
      const s = r.split('/').pop() ?? '?';
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log(`\n${name} — ${refs.length} refs this week, by type:`);
    Object.entries(bySuffix).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    await page.close();
  }
  await browser.close();
})();
