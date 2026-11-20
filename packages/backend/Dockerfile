# Stage 1: Install production dependencies only.
# The dependency and compile stages run on the build machine's own architecture
# (BUILDPLATFORM), so a cross-architecture image build does not run npm under QEMU.
# npm still installs the target's platform packages (--os/--cpu/--libc); on a
# same-architecture build these flags change nothing.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS deps
ARG TARGETARCH

WORKDIR /app
COPY package*.json ./
# Drizzle can resolve PGlite as an optional peer even when dev dependencies
# are omitted. The embedded test database is not part of the runtime image.
RUN cpu=$([ "${TARGETARCH:-amd64}" = amd64 ] && echo x64 || echo "${TARGETARCH}") \
  && npm ci --omit=dev --os=linux --cpu="$cpu" --libc=musl \
  && rm -rf node_modules/@electric-sql/pglite

# Stage 2: Precompile TypeScript once at build time, so the container starts
# with plain node instead of transpiling the whole source tree on every start.
# The output is plain JavaScript, so it is built on the build machine's architecture.
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY scripts/build.mjs ./scripts/build.mjs
COPY src/ ./src/
RUN npm run build

# Stage 3: Production image
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime

# The npm CLI bundled with the base image carries its own dependency advisories
# (tar, pacote, sigstore, picomatch, brace-expansion, ip-address). Operators still use
# npm/npx in this image, so upgrade it to a pinned release instead of removing it.
RUN npm install -g npm@11.21.2 --no-audit --no-fund && npm cache clean --force && npm -v

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules

# Copy only what's needed at runtime
COPY --chown=appuser:appgroup package*.json ./
COPY --chown=appuser:appgroup --from=build /app/dist/ ./dist/
# src/ stays for the operator scripts run with npx tsx (db:seed, payments:status).
COPY --chown=appuser:appgroup src/ ./src/

# Create assets directory for token icon cache (writable by appuser)
RUN mkdir -p /app/assets/icons && chown -R appuser:appgroup /app/assets

# Remove any local .env — Docker will inject via env_file
RUN rm -f .env .env.bak

ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
ENV AMMA_BUILD_REVISION=$VCS_REF

USER appuser

STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',{signal:AbortSignal.timeout(4000)}).then(async r=>{if(!r.ok||(await r.json()).status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"

EXPOSE 3001

CMD ["node", "--enable-source-maps", "dist/server.js"]
