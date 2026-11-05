FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HEADLESS=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright
COPY --chown=node:node . .
RUN mkdir -p downloads/videos downloads/projects uploads/references screenshots logs tmp browser-profile browser-profiles \
    && chown -R node:node /app
USER node
EXPOSE 10000
CMD ["node", "src/server.js"]
