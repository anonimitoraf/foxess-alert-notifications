# API mode (default) needs nothing but Node: the FoxESS web API is plain HTTPS.
# Browser mode is an opt-in fallback and pulls in Chromium (~700MB):
#
#   docker build --build-arg WITH_BROWSER=true -t foxess-alert-notifications .
#
# and run it with FOXESS_MODE=browser.
FROM node:24-slim

ARG WITH_BROWSER=false

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HEALTH_PORT=8080 \
    STATE_FILE=/data/state.json \
    SESSION_FILE=/data/session.json \
    TZ=UTC

WORKDIR /app

# Dependencies first so source changes do not invalidate the npm layer.
COPY package.json package-lock.json ./
RUN set -eux; \
    if [ "$WITH_BROWSER" = "true" ]; then \
      npm ci; \
      npx playwright install --with-deps chromium; \
      rm -rf /var/lib/apt/lists/* /root/.cache/ms-playwright; \
    else \
      # Playwright is an optionalDependency: skip it (and Chromium) entirely.
      npm ci --omit=optional; \
    fi; \
    npm cache clean --force

COPY src ./src

# /data holds state.json (de-duplication memory), session.json (browser mode
# cookies) and the cached signature module.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
