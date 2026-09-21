FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY saas/package.json saas/package-lock.json ./saas/
RUN cd saas && npm ci --omit=dev

COPY saas ./saas
COPY src/import ./src/import
COPY src/settings ./src/settings
COPY src/utils ./src/utils

# The image must not be able to rewrite its own code if the process is taken
# over, and the base image already ships an unprivileged `node` user.
RUN chown -R node:node /app
USER node

WORKDIR /app/saas
EXPOSE 8090
CMD ["npm", "start"]
