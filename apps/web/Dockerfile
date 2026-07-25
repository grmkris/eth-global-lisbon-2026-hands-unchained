# Hub image — built from the REPO ROOT context (monorepo lockfile lives there).
# The same build runs locally as console/agent; this container is the
# LAB_MODE=hub role only: no python driver, no arm, lobby + relay.
# Keep bun version in sync with root package.json "packageManager".
FROM oven/bun:1.3.14 AS build
WORKDIR /repo
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile
COPY apps/web apps/web
RUN cd apps/web && bun run build

FROM oven/bun:1.3.14
WORKDIR /repo
ENV NODE_ENV=production
ENV LAB_MODE=hub
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile --production
COPY --from=build /repo/apps/web/dist apps/web/dist
# cwd = the app dir: .data/ sidecar writes and dist-relative paths stay local
WORKDIR /repo/apps/web
CMD ["bun", "dist/server/server.js"]
