# syntax=docker/dockerfile:1

ARG BINARY_NAME=baal-runtime-actix

FROM node:22-bookworm AS runtime_check_dist

WORKDIR /app

COPY units/tsconfig.base.json ./units/
COPY units/shared ./units/shared
COPY units/runtime-check/package.json units/runtime-check/package-lock.json ./units/runtime-check/

RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefix units/runtime-check

COPY units/runtime-check ./units/runtime-check/

RUN mkdir -p src/libs/unit_js && npm run build --prefix units/runtime-check

FROM rust:1.93-bookworm AS builder

ARG APP_ENV
ARG BINARY_NAME
ARG CARGO_FEATURES=

RUN apt-get update && apt-get install -y \
    cmake \
    libpq-dev \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY .env.prod .env.stage ./

RUN echo "APP_ENV=$APP_ENV" && \
    if [ "$APP_ENV" = "PROD" ]; then \
      cp .env.prod .env; \
    elif [ "$APP_ENV" = "STAGE" ]; then \
      cp .env.stage .env; \
    else \
      echo "Invalid APP_ENV=$APP_ENV" && exit 1; \
    fi

COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
COPY --from=runtime_check_dist /app/units/runtime-check/dist ./units/runtime-check/dist

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo install diesel_cli --version 2.3.5 --no-default-features --features postgres

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    cargo build --release --bin "${BINARY_NAME}"

FROM debian:bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    libpq5 \
    lsof \
    wget \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.env /app/.env
COPY --from=builder /app/target/release/baal-runtime-actix /app/baal-runtime-actix
COPY --from=builder /app/migrations /app/migrations
COPY diesel-actors.toml /app/diesel-actors.toml
COPY --from=builder /usr/local/cargo/bin/diesel /usr/local/bin/diesel
COPY units ./units
RUN find ./units -name test.sh -exec chmod +x {} + \
    && mkdir -p target/release \
    && ln -sf /app/baal-runtime-actix target/release/baal-runtime-actix

EXPOSE 1501

HEALTHCHECK --interval=5s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:1501/ || exit 1

CMD ["/app/baal-runtime-actix"]
