# syntax=docker/dockerfile:1.7
FROM node:22.19.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
ARG NEXT_PUBLIC_API_ORIGIN=https://api.agentpress.example
ARG NEXT_PUBLIC_API_URL=https://api.agentpress.example/v1
ENV NEXT_PUBLIC_API_ORIGIN=$NEXT_PUBLIC_API_ORIGIN
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN pnpm build
# Keep compiled workspace output, but remove development-only dependencies before
# the runtime image copies the workspace. Production dependencies are still
# installed for every workspace importer used by the API and workers.
RUN pnpm install --prod --frozen-lockfile

FROM node:22.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.10.0 --activate
COPY --from=build /workspace /workspace
USER node

FROM runtime AS web
EXPOSE 3000
CMD ["pnpm", "--filter", "@agentpress/web", "start"]

FROM runtime AS api
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

FROM runtime AS agent-worker
CMD ["node", "apps/agent-worker/dist/main.js"]

FROM runtime AS async-worker
CMD ["node", "apps/async-worker/dist/main.js"]
