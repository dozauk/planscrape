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

## 4. Self-hosted runner: files and image

The runner image extends [myoung34/github-actions-runner](https://github.com/myoung34/docker-github-actions-runner)
with Node.js 20, Python 3, build-essential, and Playwright/Chromium system dependencies.

Keep these files together on the NAS (example path: `/volume1/docker/planscrape-runner`):

| File | Purpose |
|------|---------|
| `Dockerfile` | Custom image; base is `myoung34/github-runner:latest` (see below) |
| `docker-compose.yml` | Template: set `ACCESS_TOKEN`, adjust `REPO_URL` if not using the default repo |
| `update-planrunner-image.sh` | Optional weekly job: rebuild with `--pull`, restart only if the image ID changed |

Copy from a git clone, or fetch the current versions from GitHub:

```bash
mkdir -p /volume1/docker/planscrape-runner
cd /volume1/docker/planscrape-runner
curl -fsSL https://raw.githubusercontent.com/dozauk/planscrape/master/Dockerfile -o Dockerfile
curl -fsSL https://raw.githubusercontent.com/dozauk/planscrape/master/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/dozauk/planscrape/master/update-planrunner-image.sh -o update-planrunner-image.sh
chmod +x update-planrunner-image.sh
```

### Base image tag

The `Dockerfile` uses **`myoung34/github-runner:latest`**. Any `docker build --pull` can move
the base forward; upstream changes occasionally break the runner until you adjust the image.
The weekly `update-planrunner-image.sh` job limits surprises to that window and only restarts
the container when the rebuilt image ID actually changes. If you need maximum stability,
fork and pin to a specific tag (e.g. `ubuntu-focal`) instead of `latest`.

### First-time build

```bash
cd /volume1/docker/planscrape-runner
docker build --pull --no-cache -t planscrape-runner:latest .
```

This takes a few minutes.

> **Note:** Chromium (~200 MB) is downloaded fresh on each workflow run because the runner
> work dir is ephemeral unless you persist it. To avoid repeated Chromium downloads, mount a
> Docker volume for the Playwright cache, e.g. add to `docker-compose.yml` under the service:
> ```yaml
> volumes:
>   - runner_work:/tmp/runner
>   - playwright-cache:/root/.cache/ms-playwright
> ```
> and declare `playwright-cache:` under top-level `volumes:`.

---

## 5. Personal Access Token (runner registration)

The compose template uses `ACCESS_TOKEN`: a **classic** GitHub PAT so the container can
obtain a fresh runner registration token on each start. That avoids `RUNNER_TOKEN`, which
expires after about one hour.

**Requirements:**

- Must be a **classic** token (not fine-grained) — fine-grained tokens do not work reliably
  with this flow
- Must have the **`repo`** scope

**PATs expire.** When the token expires the runner fails to start (often HTTP 403). Fix:

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Generate a new classic token with `repo` scope
3. Set `ACCESS_TOKEN` in `docker-compose.yml` (or an env file referenced by compose)
4. Run `docker compose up -d --force-recreate`

Note the expiry when you create the token and set a reminder before it lapses.

---

## 6. Configure compose and start the runner

1. Edit `docker-compose.yml`: set `ACCESS_TOKEN`, and `REPO_URL` if your fork is not
   `https://github.com/dozauk/planscrape`.
2. Start:

```bash
cd /volume1/docker/planscrape-runner
docker compose up -d
```

Verify:

```bash
docker logs github-runner
# Should end with: Listening for Jobs
```

In GitHub → **Settings** → **Actions** → **Runners**, the runner should show as **Idle**.

### Optional: `docker run` with a one-time token

If you prefer not to use a PAT, you can run the upstream-style flow: create a self-hosted
runner in the UI, copy the **Configure** token (valid ~1 hour), and pass `RUNNER_TOKEN` per
[myoung34/github-runner](https://github.com/myoung34/docker-github-actions-runner) docs. The
compose + `ACCESS_TOKEN` approach is recommended for long-lived NAS runners.

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

The compose file uses `restart: on-failure:5` (adjust if you prefer `always`). After NAS
reboots, the container should come back when Docker starts.

To fully replace the runner container (e.g. after changing env):

```bash
cd /volume1/docker/planscrape-runner
docker compose up -d --force-recreate
```

### Weekly image rebuild (Synology Task Scheduler)

A weekly task avoids stale images while **only restarting** the runner when the rebuilt
image ID actually changes (so a no-op rebuild does not bounce the container).

1. DSM → **Task Scheduler** → **Create** → **Scheduled Task** → **User-defined script**
2. Schedule: weekly (pick a maintenance window)
3. Command:

```bash
/volume1/docker/planscrape-runner/update-planrunner-image.sh
```

The script runs `docker build --pull` (see `update-planrunner-image.sh` in the repo). If the
base or layers changed, `docker compose up -d` runs; if the image is unchanged, the container
is left running.

### Rebuilding manually

When the `Dockerfile` changes (Node bump, new system packages), rebuild and recreate:

```bash
cd /volume1/docker/planscrape-runner
docker build --pull --no-cache -t planscrape-runner:latest .
docker compose up -d --force-recreate
```

If you only use `RUNNER_TOKEN` (no PAT), you need a new registration token from GitHub after
recreate; with `ACCESS_TOKEN`, the container re-registers on its own.

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
