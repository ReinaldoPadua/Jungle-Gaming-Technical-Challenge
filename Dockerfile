# Bun executa TypeScript diretamente: não há etapa de build.
FROM oven/bun:1.2 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --production

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
