FROM node:22-alpine AS base
RUN npm install -g pnpm@10
WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./

# Copy all lib and artifact manifests
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/db/package.json ./lib/db/
COPY lib/integrations-gemini-ai/package.json ./lib/integrations-gemini-ai/
COPY artifacts/api-server/package.json ./artifacts/api-server/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy full source
COPY lib/ ./lib/
COPY artifacts/api-server/ ./artifacts/api-server/

# Build libs first, then api-server
RUN pnpm run typecheck:libs
RUN pnpm --filter @workspace/api-server run build

WORKDIR /app/artifacts/api-server

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
