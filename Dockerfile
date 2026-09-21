# ==============================================================================
# MoonVella production image
# ==============================================================================
# Node 22, NOT 20.19 — verified by attempting the install, not assumed.
#
# package.json declares "engines": { "node": ">=20.19 <22 || >=22.12" }, but
# .npmrc sets engine-strict=true and the committed lockfile pins
# @shopify/polaris-types@1.0.7, whose own engines demand node >=22.18.0.
# Under engine-strict that combination cannot install on Node 20.19, or on
# 22.12-22.17. Node 22 satisfies both the app's range and the dependency's.
# The tag is pinned to the major line deliberately: an exact-minor pin would
# silently rot as 22.x patch releases land, and 22 >= 22.18 is what matters.
#
# The host's system Node 18 is NOT used and is NOT modified by this image.
# ==============================================================================

ARG NODE_VERSION=22-alpine

FROM node:${NODE_VERSION} AS builder

# openssl is required by the Prisma query engine; libc6-compat provides the
# glibc symbols the engine expects on musl.
RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

# Dependency layer first so it is cached independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# prisma generate only needs the schema, not a reachable database. A
# placeholder is supplied so no real connection string is required at build
# time; the real value is injected at run time.
ENV DATABASE_URL="postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder"
RUN ./node_modules/.bin/prisma generate
RUN npm run build


FROM node:${NODE_VERSION} AS runner

RUN apk add --no-cache openssl libc6-compat

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# Loopback only. The container uses host networking (see docker-compose.yml),
# so this is what keeps the app off the public interface.
ENV HOST=127.0.0.1
# Uploaded images live on a mounted volume, never in the image layer.
ENV UPLOAD_DIR=/app/uploads

# Run as a fixed, unprivileged numeric identity that matches the host service
# account (moonvella, uid/gid 10001) so volume ownership lines up.
RUN addgroup -g 10001 -S moonvella \
 && adduser -u 10001 -S moonvella -G moonvella -H -s /sbin/nologin

# node_modules is carried across whole rather than reinstalled with
# --omit=dev: the Prisma CLI is needed at start-up to run migrations, and it
# lives in devDependencies. Reliability over image size was chosen deliberately.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/app ./app
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/package.json ./package.json

# The primary-owner bootstrap script, and only that one. The rest of scripts/
# holds verification harnesses that have no business in a production image:
# they create test sellers and orders. This one is needed inside the container
# because it has to reach Prisma and the credentials it carries never leave the
# host. It is run by an operator with shell access; nothing invokes it
# automatically.
COPY --from=builder /app/scripts/create-admin.mjs ./scripts/create-admin.mjs

RUN mkdir -p /app/uploads && chown -R 10001:10001 /app /app/uploads

USER 10001:10001

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1

# `migrate deploy` applies already-reviewed migrations only; it never generates
# or resets. A non-zero exit aborts the start, so a failed migration means the
# container never begins serving traffic. `exec` hands PID 1 to node so it
# receives SIGTERM directly and can drain in-flight requests.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node server.js"]
