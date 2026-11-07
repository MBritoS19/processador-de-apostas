FROM oven/bun:1.4

WORKDIR /app

# Só o necessário para rodar: dependências de produção, tsconfig (decorators) e src.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV HTTP_PORT=3000
EXPOSE 3000

USER bun

# O SIGTERM do `docker stop` aciona o shutdown gracioso (ARCHITECTURE §18/§19/§20); o compose dá 30s.
CMD ["bun", "src/main.ts"]
