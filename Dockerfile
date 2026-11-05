# Active OpenAI runtime: no Pandoc, TeX, Redis or export worker.
FROM node:24-bookworm-slim
WORKDIR /usr/src/app
ENV NODE_ENV=production HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server.mjs config.mjs db.mjs ./
COPY --chown=node:node AI_ChatBot/*.mjs ./AI_ChatBot/
COPY --chown=node:node services/*.mjs ./services/
COPY --chown=node:node middleware/*.mjs ./middleware/
COPY --chown=node:node routes/*.mjs ./routes/
COPY --chown=node:node scripts/migrate-cloud.mjs ./scripts/
COPY --chown=node:node migrations/20261104_cloud_runtime.sql ./migrations/
RUN mkdir -p uploads && chown node:node uploads
USER node
EXPOSE 5000
CMD ["npm", "run", "start:render"]
