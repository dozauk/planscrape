FROM myoung34/github-runner:latest

# Install Node.js 20 + build tools (python3 + build-essential needed by
# better-sqlite3 native bindings if no prebuilt binary matches the host)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

# Pre-install Playwright's Chromium system dependencies (libnss3, libatk etc.)
# Avoids a slow apt-get install on every workflow run.
RUN npx -y playwright@latest install-deps chromium \
    && rm -rf /var/lib/apt/lists/*
