FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=8090 \
    DATA_DIR=/app/data \
    UPLOAD_DIR=/app/uploads \
    BACKUP_DIR=/app/backups
WORKDIR /app
RUN mkdir -p /app/data /app/uploads /app/backups \
    && chown -R node:node /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8090/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
