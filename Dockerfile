FROM myoung34/github-runner:ubuntu-focal

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Pre-install Playwright's Chromium system dependencies (libnss3, libatk etc.)
# Avoids a slow apt-get install on every workflow run.
RUN npx -y playwright@latest install-deps chromium \
    && rm -rf /var/lib/apt/lists/*
