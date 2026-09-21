FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY saas/package.json saas/package-lock.json ./saas/
RUN cd saas && npm ci --omit=dev

COPY saas ./saas
COPY src/import ./src/import
COPY src/settings ./src/settings
COPY src/utils ./src/utils

WORKDIR /app/saas
EXPOSE 8090
CMD ["npm", "start"]
