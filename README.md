# planscrape

Scrapes planning application decisions from three Kent councils daily, stores them in SQLite, publishes a filterable web dashboard, and sends a weekly email digest.

**Live dashboard:** https://www.doza.org/planscrape

---

## Councils covered

| Council | Portal |
|---|---|
| Tunbridge Wells | Idox PublicAccess |
| Sevenoaks | Idox PublicAccess |
| Wealden | ASP.NET MVC custom portal |

---

## How it works

A **daily GitHub Actions workflow** (self-hosted runner on a NAS — residential IP required) scrapes each council for applications decided in the last 14 days, upserts them into a SQLite database, classifies new entries via Claude AI, and publishes an updated web page to GitHub Pages.

A **weekly email digest** (Mondays) reads from the same database and sends a formatted HTML email via Resend.

---

## Outputs

- **Web UI** — sortable/filterable Tabulator table, defaulting to high-priority approved applications. Updated daily.
- **Email digest** — weekly HTML email with a leads summary (high-priority approved) and per-council breakdown sorted by priority then decision.

---

## Local development

```bash
cp .env.example .env          # fill in secrets (all optional for scrape-only testing)
npm install
npx playwright install chromium --with-deps

npm start                     # scrape → planscrape.db + web-output/index.html
npm run preview               # generate email-preview.html/.txt from local DB
npm run start:digest          # send weekly digest email
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for full self-hosted runner setup.

---

## Secrets

| Secret | Purpose |
|---|---|
| `RESEND_API_KEY` | Email sending (weekly digest) |
| `EMAIL_TO` | Digest recipient(s), comma-separated |
| `EMAIL_FROM` | Verified Resend sender address |
| `ANTHROPIC_API_KEY` | AI classification (optional) |
| `CLASSIFICATION_PROMPT` | Classification criteria (optional) |
| `PLANSCRAPE_URL` | Dashboard URL in digest emails (default: `https://www.doza.org/planscrape`) |
