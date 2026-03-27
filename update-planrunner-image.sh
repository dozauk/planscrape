#!/bin/bash
cd /volume1/docker/planscrape-runner

DIGEST_FILE=".base-digest"
STORED_DIGEST=$(cat "$DIGEST_FILE" 2>/dev/null)

docker pull myoung34/github-runner:latest
CURRENT_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' myoung34/github-runner:latest)

if [ "$STORED_DIGEST" = "$CURRENT_DIGEST" ]; then
    echo "Base image unchanged, skipping rebuild."
    exit 0
fi

echo "Base image updated, rebuilding..."
docker build -t planscrape-runner:latest .
echo "$CURRENT_DIGEST" > "$DIGEST_FILE"

echo "Recreating container..."
docker rm -f github-runner
docker compose up -d --force-recreate
