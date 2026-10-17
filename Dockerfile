# lincor server: one image with the Rust API server and the web app embedded.
# Build: docker build -t lincor .     Run: docker run -p 8080:8080 -v lincor-data:/data lincor

FROM node:22-bookworm-slim AS web
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY web/package.json web/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/core packages/core
COPY web web
RUN npm run build -w @lincor/core && npm run build -w @lincor/web

FROM rust:1-bookworm AS server
WORKDIR /src
COPY server server
COPY --from=web /src/web/dist web/dist
RUN cd server && cargo build --release --locked && cp target/release/lincor-server /usr/local/bin/lincor-server

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 lincor \
 && mkdir -p /data \
 && chown lincor /data
COPY --from=server /usr/local/bin/lincor-server /usr/local/bin/lincor-server
USER lincor
ENV LINCOR_BIND=0.0.0.0:8080 \
    LINCOR_DATABASE_URL=sqlite:///data/lincor.db?mode=rwc \
    LINCOR_BLOB_DIR=/data/blobs
VOLUME /data
EXPOSE 8080
CMD ["lincor-server"]
