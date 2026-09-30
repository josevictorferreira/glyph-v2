{
  description = "glyph — visual designer, scheduler and runner for DAG-shaped AI workflows (Rust backend)";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;

        postgres = pkgs.postgresql_18;
        pi = pkgs.pi-coding-agent;

        commonDeps = with pkgs; [
          rustc
          cargo
          clippy
          rustfmt
          rust-analyzer
          sqlx-cli
          pkg-config
          openssl
          gcc
          postgres
          pi
          nodejs_22
          pnpm
          buf
          cargo-deny
          grpcurl
          jq
          git
          coreutils
          gnused
          gnugrep
          procps
          findutils
          psmisc
          tzdata
          cacert
          curl
        ];

        # ------------------------------------------------------------------
        # Shared bootstrap library, sourced by every runnable package.
        #
        # Everything lives under ./.dev (gitignored) so state persists between
        # runs and never touches the user's system PostgreSQL.
        # ------------------------------------------------------------------
        bootstrapLib = ''
          ROOT="$PWD"
          if [ ! -f "$ROOT/flake.nix" ]; then
            echo "glyph: run this from the repository root (no flake.nix in $ROOT)" >&2
            exit 1
          fi

          # Optional local secrets (API keys). Gitignored.
          if [ -f "$ROOT/.env" ]; then
            set -a
            # shellcheck disable=SC1091
            . "$ROOT/.env"
            set +a
          fi

          export ROOT
          export DEV_DIR="$ROOT/.dev"
          export PG_BASE="$DEV_DIR/postgres"
          export PG_LOG_DIR="$DEV_DIR/log"
          export PG_LOG="$PG_LOG_DIR/postgres.log"

          export PGDATA="$PG_BASE/data"
          export PGHOST="$PG_BASE/socket"
          export PGPORT="''${PGPORT:-55432}"
          export PGUSER="postgres"
          export PGDATABASE="postgres"

          export DATABASE_URL="''${DATABASE_URL:-postgres://postgres:postgres@localhost:$PGPORT/glyph_development}"
          export TZ="''${TZ:-America/Sao_Paulo}"
          export SSL_CERT_FILE="''${SSL_CERT_FILE:-${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt}"
          export GLYPH_PI_BIN="''${GLYPH_PI_BIN:-${pi}/bin/pi}"
          export CARGO_TARGET_DIR="''${CARGO_TARGET_DIR:-$ROOT/backend/target}"

          log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
          warn() { printf '\033[1;33m==>\033[0m %s\n' "$*" >&2; }

          dev_dirs() {
            mkdir -p "$PGDATA" "$PGHOST" "$PG_LOG_DIR" "$DEV_DIR/pids"
          }

          pg_running() {
            pg_ctl -D "$PGDATA" status >/dev/null 2>&1
          }

          pg_start() {
            dev_dirs

            if [ ! -f "$PGDATA/PG_VERSION" ]; then
              log "Initializing PostgreSQL cluster in .dev/postgres/data"
              initdb -D "$PGDATA" --username=postgres --auth=trust --encoding=UTF8 \
                --locale=C >"$PG_LOG_DIR/initdb.log" 2>&1
            fi

            if pg_running; then
              log "PostgreSQL already running on port $PGPORT"
              return 0
            fi
            PG_STARTED_HERE=1

            log "Starting PostgreSQL on localhost:$PGPORT (socket: .dev/postgres/socket)"
            pg_ctl -D "$PGDATA" -l "$PG_LOG" -w -o \
              "-p $PGPORT -k '$PGHOST' -c listen_addresses=localhost -c fsync=off -c synchronous_commit=off -c max_connections=300" \
              start

            local tries=0
            until pg_isready -q -h "$PGHOST" -p "$PGPORT" -U postgres; do
              tries=$((tries + 1))
              if [ "$tries" -gt 30 ]; then
                echo "PostgreSQL failed to become ready; see $PG_LOG" >&2
                tail -20 "$PG_LOG" >&2 || true
                exit 1
              fi
              sleep 1
            done
            log "PostgreSQL ready"
          }

          PG_STARTED_HERE=0

          # Stops Postgres only when this invocation started it.
          pg_stop_if_started() {
            if [ "$PG_STARTED_HERE" = 1 ]; then
              pg_stop
            fi
          }

          pg_stop() {
            if pg_running; then
              log "Stopping PostgreSQL"
              pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
            fi
          }

          ensure_db() {
            local name="$1"
            if ! psql -h "$PGHOST" -p "$PGPORT" -U postgres -tAc \
              "SELECT 1 FROM pg_database WHERE datname = '$name'" | grep -q 1; then
              log "Creating database $name"
              createdb -h "$PGHOST" -p "$PGPORT" -U postgres "$name"
            fi
          }

          # Migrations run at server boot; this only makes sure the DB exists.
          db_prepare() {
            ensure_db glyph_development
          }
        '';

        # ------------------------------------------------------------------
        # The backend binary, built offline (sqlx .sqlx data, protox codegen).
        # ------------------------------------------------------------------
        glyph = pkgs.rustPlatform.buildRustPackage {
          pname = "glyph-backend";
          version = "0.1.0";
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./backend/Cargo.toml
              ./backend/Cargo.lock
              ./backend/build.rs
              ./backend/src
              ./backend/migrations
              ./backend/.sqlx
              ./proto
            ];
          };
          cargoRoot = "backend";
          buildAndTestSubdir = "backend";
          cargoLock.lockFile = ./backend/Cargo.lock;
          nativeBuildInputs = [
            pkgs.cmake
            pkgs.perl
          ];
          SQLX_OFFLINE = "true";
          # Tests need Postgres; they run via `nix run .#test`.
          doCheck = false;
          meta.mainProgram = "glyph";
        };

        # Runtime image: the binary, Pi (same nixpkgs version as the dev shell)
        # and the tools Pi's bash tool may call. Non-root, /tmp for step dirs.
        image = pkgs.dockerTools.buildLayeredImage {
          name = "glyph";
          tag = "latest";
          contents = with pkgs; [
            glyph
            pi
            cacert
            tzdata
            bashInteractive
            coreutils
            findutils
            gnugrep
            gnused
          ];
          extraCommands = ''
            mkdir -p tmp home/glyph
            chmod 1777 tmp
          '';
          fakeRootCommands = ''
            chown -R 1000:1000 home/glyph
          '';
          config = {
            Entrypoint = [ "${glyph}/bin/glyph" ];
            User = "1000:1000";
            WorkingDir = "/home/glyph";
            ExposedPorts."3000/tcp" = { };
            Env = [
              "HOME=/home/glyph"
              "PATH=/bin"
              "TZ=UTC"
              "GLYPH_LISTEN_ADDR=0.0.0.0:3000"
              "GLYPH_PI_BIN=${pi}/bin/pi"
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
          };
        };

        mkApp =
          name: text:
          pkgs.writeShellApplication {
            inherit name;
            runtimeInputs = commonDeps;
            text = bootstrapLib + "\n" + text;
          };

        # ------------------------------------------------------------------
        # nix run .#web — Postgres + backend (+ frontend once it exists).
        # ------------------------------------------------------------------
        web = mkApp "web" ''
          PORT="''${PORT:-3000}"
          export GLYPH_LISTEN_ADDR="''${GLYPH_LISTEN_ADDR:-0.0.0.0:$PORT}"
          PIDS=()

          cleanup() {
            for pid in "''${PIDS[@]}"; do
              if kill -0 "$pid" 2>/dev/null; then
                kill -INT "$pid" 2>/dev/null || true
              fi
            done
            for pid in "''${PIDS[@]}"; do
              wait "$pid" 2>/dev/null || true
            done
            pg_stop
          }
          trap cleanup EXIT INT TERM

          # Free the ports from a previous run.
          fuser -k "$PORT/tcp" 2>/dev/null || true
          fuser -k 5173/tcp 2>/dev/null || true

          pg_start
          db_prepare

          (cd "$ROOT/backend" && SQLX_OFFLINE=true exec cargo run --bin glyph) &
          PIDS+=($!)

          if [ -f "$ROOT/frontend/package.json" ]; then
            # exec vite itself (not `pnpm dev`): pnpm does not forward the
            # cleanup signal, which left an orphaned Vite holding :5173.
            (cd "$ROOT/frontend" && pnpm install --frozen-lockfile && exec ./node_modules/.bin/vite) &
            PIDS+=($!)
          fi

          cat >&2 <<BANNER

            glyph is starting

              http://localhost:$PORT/up      health
              localhost:$PORT                gRPC + gRPC-Web (grpcurl -plaintext localhost:$PORT list)
              http://localhost:5173         web UI (Vite dev server, proxies API calls to :$PORT)

            Ctrl-C stops the server and PostgreSQL.

          BANNER

          wait
        '';

        test = mkApp "test" ''
          trap pg_stop_if_started EXIT INT TERM
          pg_start
          ensure_db glyph_test
          export DATABASE_URL="postgres://postgres:postgres@localhost:$PGPORT/glyph_test"
          export SQLX_OFFLINE=true
          cd "$ROOT/backend"
          cargo test "$@"
        '';

        check = mkApp "check" ''
          trap pg_stop_if_started EXIT INT TERM
          pg_start
          ensure_db glyph_test
          export DATABASE_URL="postgres://postgres:postgres@localhost:$PGPORT/glyph_test"
          export SQLX_OFFLINE=true
          (cd "$ROOT/proto" && buf lint)
          if git -C "$ROOT" rev-parse --verify -q main >/dev/null && \
            git -C "$ROOT" cat-file -e main:proto/buf.yaml 2>/dev/null; then
            (cd "$ROOT/proto" && buf breaking --against "$ROOT/.git#branch=main,subdir=proto")
          fi
          cd "$ROOT/backend"
          cargo fmt --check
          cargo clippy --all-targets -- -D warnings
          cargo deny check
          cargo test

          if [ -f "$ROOT/frontend/package.json" ]; then
            cd "$ROOT/frontend"
            pnpm install --frozen-lockfile
            pnpm gen
            if ! git -C "$ROOT" diff --exit-code -- frontend/src/gen; then
              echo "frontend/src/gen is stale: commit the output of 'pnpm gen'" >&2
              exit 1
            fi
            pnpm lint
            pnpm typecheck
            pnpm test
            # Production build + bundle budget (0022): postbuild runs
            # scripts/bundle-size.mjs (entry chunk ≤ 850 KB gzip, chunks stay
            # under dist/assets|workers/).
            pnpm build
            # e2e (0022): the suite boots the full stack itself (fake runner +
            # mock Velox). On NixOS the Playwright-downloaded browser cannot
            # run (missing system libs); point it at nixpkgs chromium unless
            # already overridden.
            export PLAYWRIGHT_CHROMIUM_PATH="''${PLAYWRIGHT_CHROMIUM_PATH:-${pkgs.chromium}/bin/chromium}"
            # The e2e stack (nested nix run .#web) must use the development
            # database, not the glyph_test one this check exports for cargo.
            env -u DATABASE_URL pnpm e2e
          fi
        '';

        seed = mkApp "seed" ''
          PORT="''${PORT:-3000}"
          SEED="$ROOT/backend/seeds/design_poc_tournament.yml"
          NAME="Design POC Tournament"
          if grpcurl -plaintext -d "{\"query\":\"$NAME\"}" "localhost:$PORT" \
            glyph.v1.WorkflowService/ListWorkflows | grep -q "\"name\": \"$NAME\""; then
            log "'$NAME' already exists, nothing to do"
            exit 0
          fi
          log "Importing $NAME"
          jq -n --rawfile yaml "$SEED" '{yaml: $yaml}' | \
            grpcurl -plaintext -d @ "localhost:$PORT" glyph.v1.DefinitionService/ImportWorkflow
        '';

        reset = mkApp "reset" ''
          pg_stop
          log "Removing .dev (PostgreSQL data, logs, pids)"
          rm -rf "$DEV_DIR"
          log "Done. Next 'nix run .#web' starts from scratch."
        '';

        mkRun = drv: {
          type = "app";
          program = "${drv}/bin/${drv.name}";
        };
      in
      {
        packages = {
          inherit
            glyph
            image
            web
            test
            check
            seed
            reset
            ;
          default = web;
        };

        apps = {
          web = mkRun web;
          test = mkRun test;
          check = mkRun check;
          seed = mkRun seed;
          reset = mkRun reset;
          default = mkRun web;
        };

        devShells.default = pkgs.mkShell {
          packages = commonDeps ++ [
            web
            test
            check
            reset
          ];

          shellHook = ''
            ${bootstrapLib}

            db_start() { pg_start; db_prepare; }
            db_stop() { pg_stop; }
            db_psql() { psql -h "$PGHOST" -p "$PGPORT" -U postgres "''${1:-glyph_development}"; }
            db_migrate() { (cd "$ROOT/backend" && sqlx migrate run); }
            sqlx_prepare() { (cd "$ROOT/backend" && cargo sqlx prepare -- --all-targets); }

            export -f log warn dev_dirs pg_running pg_start pg_stop pg_stop_if_started ensure_db db_prepare \
              db_start db_stop db_psql db_migrate sqlx_prepare

            echo ""
            echo "=== glyph dev shell ==="
            echo "Rust:       $(rustc --version)"
            echo "PostgreSQL: $(postgres --version)"
            echo "Pi:         $(pi --version 2>/dev/null || echo n/a)"
            echo ""
            echo "  db_start / db_stop / db_psql / db_migrate   local PostgreSQL (port $PGPORT)"
            echo "  sqlx_prepare                                refresh backend/.sqlx offline data"
            echo "  web / test / check / reset                  same as nix run .#<name>"
            echo ""
          '';
        };

        formatter = pkgs.nixfmt;
      }
    );
}
