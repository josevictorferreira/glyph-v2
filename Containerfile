# ---- Build stage ----
FROM docker.io/library/rust:1-slim-bookworm AS build
WORKDIR /app

# rustls (sqlx, reqwest) pulls aws-lc-rs, whose C build needs cmake; perl backs
# the C toolchain glue. rustls everywhere means no OpenSSL, so no libssl-dev.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential pkg-config cmake perl \
 && rm -rf /var/lib/apt/lists/*

# Build dependencies against a stub source first. This layer is keyed on the
# manifests plus everything compiled *into* the crate: build.rs reads ../proto
# (protox: pure-Rust protoc, no protoc binary) and sqlx macros read .sqlx under
# SQLX_OFFLINE=true. Editing src/ does not rebuild ~250 crates.
COPY backend/Cargo.toml backend/Cargo.lock ./backend/
COPY backend/build.rs ./backend/
COPY backend/.sqlx ./backend/.sqlx
COPY proto ./proto
RUN mkdir -p backend/src \
 && echo 'fn main() {}' > backend/src/main.rs \
 && echo '' > backend/src/lib.rs \
 && cd backend \
 && SQLX_OFFLINE=true cargo build --release --locked \
 && rm -rf src

COPY backend/src ./backend/src
# sqlx::migrate! embeds ./migrations at compile time. tests/ is not needed:
# its fixtures are only include_str!'d under #[cfg(test)].
COPY backend/migrations ./backend/migrations
# cargo keys off mtime; the stub artifacts must be invalidated or the real
# binary is silently never compiled.
RUN cd backend \
 && touch src/main.rs src/lib.rs \
 && SQLX_OFFLINE=true cargo build --release --locked \
 && strip target/release/glyph

# ---- Frontend stage ----
# Vite build of the SPA. Generated code (src/gen, routeTree.gen.ts) is
# committed, so there is no buf/protoc step here. Manifests are copied first
# so the dependency install layer is cached independently of src edits.
FROM docker.io/library/node:22-bookworm-slim AS frontend
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend ./
RUN pnpm build

# ---- Runtime stage ----
# Not distroless like velox: step runs spawn the Pi agent as a subprocess
# (GLYPH_PI_BIN), and Pi is a Node 22 app, so the image carries Node plus the
# shell tools Pi's bash tool may call (the same set the Nix image ships).
FROM docker.io/library/node:22-bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 # Pinned to the same 0.83 the flake's nixpkgs provides, so local runs and the
 # image execute the same agent. --ignore-scripts per Pi's install docs.
 && npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.83.0

COPY --from=build /app/backend/target/release/glyph /usr/local/bin/glyph

# The backend serves the SPA from here (spec 0022: one image, one origin on
# :3000). GLYPH_STATIC_DIR is not read by the backend yet (0022 task 1); it is
# wired now so the image needs no rebuild once static serving lands.
COPY --from=frontend /app/dist /app/static

# The runner passes PATH through to the step-run child, so an absolute
# GLYPH_PI_BIN is belt-and-braces. Step runs get a temp HOME under /tmp, which
# is 1777 in this base.
ENV GLYPH_LISTEN_ADDR=0.0.0.0:3000 \
    GLYPH_PI_BIN=/usr/local/bin/pi \
    GLYPH_STATIC_DIR=/app/static \
    TZ=UTC

# The `node` user is uid 1000, matching the Nix image's 1000:1000.
USER node
WORKDIR /home/node

EXPOSE 3000

# Health is GET /up (HTTP) and grpc.health.v1 (gRPC); wire those to your
# orchestrator's probes. No HEALTHCHECK here, since it would mean shipping curl.
ENTRYPOINT ["glyph"]
