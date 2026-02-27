# Architecture

## System overview

```
GitHub Actions (self-hosted NAS runner)
│
├── Daily scrape (07:00 UTC)
│   ├── Download planscrape-db artifact  ← previous DB
│   ├── Playwright scrapes TW, Sevenoaks, Wealden
│   ├── Upsert into planscrape.db
│   ├── Classify new applications via Claude AI
│   ├── Generate web-output/index.html
│   ├── Upload planscrape-db artifact    → next day's run
│   └── Deploy to GitHub Pages
│
└── Weekly digest (Monday 08:00 UTC)
    ├── Download planscrape-db artifact
    └── Send HTML email via Resend
```

## Source modules

| File | Role |
|---|---|
| `src/index.ts` | Entry point: orchestrates scraping, classification, HTML generation |
| `src/scrapers/idox.ts` | Playwright scraper for Idox PublicAccess portals (TW + Sevenoaks) |
| `src/scrapers/wealden.ts` | Playwright scraper for Wealden's custom ASP.NET portal |
| `src/db.ts` | SQLite helpers: open, upsert, migrate, query; `knownDecisions` cache |
| `src/classify.ts` | Claude AI classification (`priority`: high/medium/low/none) |
| `src/generate.ts` | Generates `web-output/index.html` (Tabulator table, inline JS/CSS) |
| `src/template.ts` | HTML + plain-text email rendering (no infrastructure dependencies) |
| `src/email.ts` | Thin Resend wrapper around `template.ts` |
| `src/digest.ts` | Weekly digest entry point: reads DB, calls `sendDigest` |
| `src/preview.ts` | Local preview: writes `email-preview.html/.txt` without sending |
| `src/types.ts` | `Application` interface and `CouncilId` type |
| `src/debug.ts` | Diagnostic listeners and debug snapshot helpers |

## Data flow

```
Playwright browser
  → scrapeIdox / scrapeWealden
      → knownDecisions cache (DB) skips already-decided apps
      → fetchDetail (detail page) for new apps only
  → upsertApplications (SQLite)
  → classifyApplication (Claude API) for unclassified rows
  → generateHtml → web-output/index.html → GitHub Pages

planscrape.db (artifact)
  → getApplicationsForDigest
  → buildHtml / buildText (template.ts)
  → Resend API → email inbox
```

## Database

Single SQLite file (`planscrape.db`) persisted as a GitHub Actions artifact.

**`applications` table** — one row per council + reference:

| Column | Notes |
|---|---|
| `id` | `"council:applreference"` — primary key |
| `council` | `TW` / `Sevenoaks` / `Wealden` |
| `applreference` | Planning reference number |
| `address`, `description` | From results list |
| `datereceived`, `datevalidated` | ISO dates |
| `status`, `decision`, `decision_date` | From detail page |
| `appeal_decision`, `appeal_date` | From detail page |
| `detailsurl` | Direct link to council system |
| `first_seen`, `last_seen` | ISO timestamps |
| `priority`, `priority_reason` | AI classification output |

**`scrape_runs` table** — one row per scrape attempt per council (used for last-scrape status chips on the web UI).

## Key design decisions

**Self-hosted runner (residential IP):** Several portals (notably Sevenoaks) block GitHub-hosted runner IP ranges. The NAS runner uses a home IP, bypassing these blocks.

**Detail page cache:** On each run, `getDecidedApplications()` returns a map of applications already in the DB with a decision. Scrapers skip detail-page fetches for these — reducing HTTP requests from ~60 to typically 0–5 on a normal daily run, avoiding 429 rate limits entirely.

**SQLite artifact:** Avoids any cloud database dependency. The DB is downloaded at the start of each run and re-uploaded at the end, giving persistent storage with zero hosting cost.

**AI classification is optional:** If `ANTHROPIC_API_KEY` / `CLASSIFICATION_PROMPT` are absent, `isClassificationEnabled()` returns false, all priority fields remain null, and the digest includes all applications unfiltered.

**`template.ts` separation:** Email HTML/text rendering has no infrastructure dependencies, making it directly importable for local preview (`npm run preview`) without mocking Resend.
