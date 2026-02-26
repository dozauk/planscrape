# Deployment Guide

Runs as a **daily** GitHub Actions workflow on a self-hosted runner (Synology NAS or similar).
The runner uses a residential IP to reach council planning portals that block cloud provider
IP ranges (e.g. pa.sevenoaks.gov.uk blocks GitHub/Azure).

Results are stored in a SQLite database (persisted as a GitHub Actions artifact) and published
to a **GitHub Pages** web page with a filterable/sortable table. A separate **weekly email
digest** runs on Mondays, reading from the same database.

---

## Prerequisites

- A GitHub account with this repo forked or cloned
- A [Resend](https://resend.com) account and API key (free tier is sufficient) — only needed
  for email digests; the web page works without it
- A Synology NAS (x86_64, DSM 7.x) with Container Manager installed, and SSH access
  - ARM-based NAS models are not supported (Playwright/Chromium requires x86_64)

---

## 1. Resend setup (optional — email digest only)

1. Sign up at [resend.com](https://resend.com) and create an API key
2. Verify a sending domain, or use `onboarding@resend.dev` for testing (sends only to
   the account's own email address)

---

## 2. GitHub secrets

Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret | Value |
|---|---|
| `RESEND_API_KEY` | Your Resend API key (`re_xxxx`) — required for email digest only |
| `EMAIL_TO` | Recipient email address(es), comma-separated |
| `EMAIL_FROM` | Sending address (must match your verified Resend domain, or `onboarding@resend.dev`) |

---

## 3. GitHub Pages setup

1. Go to your repo → **Settings** → **Pages**
2. Under **Build and deployment → Source**, select **GitHub Actions**
3. Go to **Settings** → **Environments** → **github-pages**
4. Under **Deployment branches and tags**, set to **No restriction** (required if you want
   to deploy from a non-default branch, or to allow the self-hosted runner's workflow)

The web page will be published at `https://<your-username>.github.io/<repo-name>/` after the
first successful daily run.

---

## 4. Build the custom runner image on the NAS

The custom image pre-installs Node.js 20 and Playwright's Chromium system dependencies,
plus Python 3 and build-essential for the `better-sqlite3` native bindings.

SSH into the NAS, then:

```bash
mkdir -p /tmp/runner-build
curl -fsSL https://raw.githubusercontent.com/dozauk/planscrape/master/Dockerfile \
  -o /tmp/runner-build/Dockerfile
sudo docker build -t planscrape-runner /tmp/runner-build/
```

This takes a few minutes and only needs to be repeated if the `Dockerfile` changes.

> **Note:** Chromium (~200 MB) is downloaded fresh on each run because the runner container
> is stateless. To avoid repeated downloads, you can mount a Docker volume to persist the
> Playwright cache between container rebuilds:
> ```bash
> sudo docker volume create playwright-cache
> # Add to the docker run command: -v playwright-cache:/root/.cache/ms-playwright
> ```

---

## 5. Register a GitHub Actions runner token

Go to your repo → **Settings** → **Actions** → **Runners** → **New self-hosted runner**

Copy the token shown in the **Configure** section. It looks like `AASXXXXXXXXXXXXXXXXXX`
and is valid for one hour (long enough to complete step 6).

---

## 6. Start the runner container

```bash
sudo docker run -d \
  --name github-runner \
  --restart always \
  --shm-size=256m \
  --security-opt seccomp=unconfined \
  -e REPO_URL=https://github.com/dozauk/planscrape \
  -e RUNNER_NAME=synology-nas \
  -e LABELS=self-hosted \
  -e RUNNER_TOKEN=AASXXXXXXXXXXXXXXXXXX \
  -e RUNNER_WORKDIR=/tmp/runner \
  planscrape-runner
```

Verify it connected:

```bash
sudo docker logs github-runner
# Should end with: Listening for Jobs
```

Then confirm in GitHub → **Settings** → **Actions** → **Runners** — the runner should
show as **Idle**.

---

## 7. Test the workflow

Go to your repo → **Actions** → **Daily Planning Scrape** → **Run workflow** → **Run workflow**

A successful run will:
- Complete all three scrapers (TW, Sevenoaks, Wealden)
- Upsert results into `planscrape.db` and upload it as a GitHub Actions artifact
- Deploy an updated web page to GitHub Pages
- Print a summary in the logs, e.g. `[TW] Found 12 applications`

---

## Schedules

| Workflow | File | Schedule |
|---|---|---|
| **Daily Planning Scrape** | `.github/workflows/daily-scrape.yml` | Every day at **07:00 UTC** |
| **Weekly Email Digest** | `.github/workflows/weekly-digest.yml` | Every **Monday at 08:00 UTC** |

The email digest runs 1 hour after the daily scrape to ensure the database is up to date.

---

## Database persistence

The SQLite database (`planscrape.db`) is stored as a GitHub Actions artifact named
`planscrape-db`. Each daily run:

1. Downloads the latest artifact (if one exists) to restore previous data
2. Upserts new results (preserving `first_seen` timestamps)
3. Re-uploads the updated database with 90-day retention
4. Cleans up artifacts older than 7 days

On the very first run, the database is created fresh and all history begins from that run.

---

## Failure notifications

If any scraper fails (website down, selectors changed, timeout), the workflow exits with
code 1, triggering a GitHub Actions failure email to the repo owner. The other scrapers
continue running regardless.

Debug snapshots (screenshot, page HTML, metadata) are uploaded as a workflow artifact
named `debug-snapshots` on every run, including failures.

---

## Ongoing maintenance

### Runner container

The container restarts automatically after NAS reboots (`--restart always`).

If you need to re-register the runner (e.g. token expired, container recreated):

```bash
sudo docker rm -f github-runner
# Get a new token from GitHub → Settings → Actions → Runners → New self-hosted runner
sudo docker run -d ... -e RUNNER_TOKEN=NEW_TOKEN ... planscrape-runner
```

### Rebuilding the image

Only needed when `Dockerfile` changes (Node.js version bump, new system dependencies):

```bash
curl -fsSL https://raw.githubusercontent.com/dozauk/planscrape/master/Dockerfile \
  -o /tmp/runner-build/Dockerfile
sudo docker build -t planscrape-runner /tmp/runner-build/
sudo docker rm -f github-runner
# Re-run step 5 (new token) then step 6
```

### Scraper breakage

Council planning portals occasionally change their HTML structure. If a scraper starts
returning 0 results or timing out, check the `debug-snapshots` artifact in the failed
workflow run — the screenshot and `meta.json` show the page state at the point of failure.

---

## Local development

```bash
cp .env.example .env
# Fill in RESEND_API_KEY, EMAIL_TO, EMAIL_FROM (all optional for scrape-only testing)

npm install
npx playwright install chromium --with-deps

# Run the daily scrape (creates/updates planscrape.db and generates web-output/index.html)
npm start

# Send the weekly email digest (reads from planscrape.db)
npm run start:digest
```
