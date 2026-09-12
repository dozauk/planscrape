FROM myoung34/github-runner:latest

# Install Node.js 20 + build tools (python3 + build-essential needed by
# better-sqlite3 native bindings if no prebuilt binary matches the host)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# Pre-warm Playwright's Chromium system dependencies (libnss3, libatk, libnspr4
# etc.) so the runtime `playwright install --with-deps` step below is a fast
# no-op in the common case. This uses whatever Playwright is "latest" at image
# build time, which can drift from the repo's pinned version (package.json)
# between weekly rebuilds — the workflow's --with-deps flag is what actually
# guarantees correctness at runtime; this is purely a speed optimization.
RUN npx -y playwright@latest install-deps chromium \
    && rm -rf /var/lib/apt/lists/*
