FROM rust:1-slim-bookworm AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

# Cache dependencies layer
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
    && cargo build --release \
    && rm -rf src

# Build real binary (sqlx::migrate! embeds migrations at compile time)
COPY src ./src
COPY migrations ./migrations
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/api .
EXPOSE 8080
CMD ["./api"]
