# One image for both sites; SITE=led|grid picks the brand, catalog and profile.
FROM node:22-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production NODE_NO_WARNINGS=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate \
 && apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-wqy-microhei && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/
COPY sites/led/package.json sites/led/
COPY sites/grid/package.json sites/grid/
RUN pnpm install --frozen-lockfile --prod=false
COPY . .
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/bootstrap.js"]
