# Deployment Guide

Runs as a weekly GitHub Actions workflow on a self-hosted runner (Synology NAS or similar).
The runner uses a residential IP to reach council planning portals that block cloud provider
IP ranges (e.g. pa.sevenoaks.gov.uk blocks GitHub/Azure).

---

## Prerequisites

- A GitHub account with this repo forked or cloned
- A [Resend](https://resend.com) account and API key (free tier is sufficient)
- A Synology NAS (x86_64, DSM 7.x) with Container Manager installed, and SSH access
  - ARM-based NAS models are not supported (Playwright/Chromium requires x86_64)

---

## 1. Resend setup

1. Sign up at [resend.com](https://resend.com) and create an API key
2. Verify a sending domain, or use `onboarding@resend.dev` for testing (sends only to
   the account's own email address)

---

## 2. GitHub secrets

Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret | Value |
|---|---|
| `RESEND_API_KEY` | Your Resend API key (`re_xxxx`) |
| `EMAIL_TO` | Recipient email address |
| `EMAIL_FROM` | Sending address (must match your verified Resend domain, or `onboarding@resend.dev`) |

---

## 3. Build the custom runner image on the NAS

The custom image pre-installs Node.js 20 and Playwright's Chromium system dependencies so
they don't need to be downloaded on every workflow run.

SSH into the NAS, then:

```bash
mkdir -p /tmp/runner-build
curl -fsSL https://raw.githubusercontent.com/dozauk/planscrape/master/Dockerfile \
  -o /tmp/runner-build/Dockerfile
sudo docker build -t planscrape-runner /tmp/runner-build/
```

This takes a few minutes and only needs to be repeated if the `Dockerfile` changes
(e.g. Node.js major version bump).

---

## 4. Register a GitHub Actions runner token

Go to your repo → **Settings** → **Actions** → **Runners** → **New self-hosted runner**

Copy the token shown in the **Configure** section. It looks like `AASXXXXXXXXXXXXXXXXXX`
and is valid for one hour (long enough to complete step 5).

---

## 5. Start the runner container

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

## 6. Test the workflow

Go to your repo → **Actions** → **Weekly Planning Digest** → **Run workflow** → **Run workflow**

A successful run will:
- Complete all three scrapers (TW, Sevenoaks, Wealden)
- Print JSON output in the "Run scraper" step logs
- Send an email digest if `RESEND_API_KEY` and `EMAIL_TO` are set

---

## Schedule

The workflow runs automatically every **Monday at 07:00 UTC** (`cron: '0 7 * * 1'`).
To change the schedule, edit `.github/workflows/weekly-digest.yml`.

---

## Failure notifications

If any scraper fails (website down, selectors changed, timeout), the workflow exits with
code 1, triggering a GitHub Actions failure email to the repo owner. The digest email is
still sent with results from the working scrapers and an error banner for the failed ones.

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
# Re-run step 4 (new token) then step 5
```

### Scraper breakage

Council planning portals occasionally change their HTML structure. If a scraper starts
returning 0 results or timing out, check the `debug-snapshots` artifact in the failed
workflow run — the screenshot and `meta.json` show the page state at the point of failure.

---

## Local development

```bash
cp .env.example .env
# Fill in RESEND_API_KEY, EMAIL_TO, EMAIL_FROM

npm install
npx playwright install chromium --with-deps

npm start
```
