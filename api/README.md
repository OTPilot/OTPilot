# OTPilot API

Rust + Axum backend. Handles cloud sync, billing, and team management. Validates Supabase JWTs for authentication — all app data lives in PostgreSQL.

## Stack

- **Rust** + **Axum** 0.8
- **SQLx** 0.8 (compile-time safe queries, embedded migrations)
- **PostgreSQL** (local via Docker, production on Supabase)
- **Supabase Auth** — JWT verification via JWKS endpoint
- **Stripe** — Checkout + webhooks

## Running locally

```bash
# From repo root: start PostgreSQL
docker compose up postgres -d

# From api/
cargo run
```

The server starts on `http://localhost:8080`. Migrations run automatically on startup.

## Environment variables

Copy from `api/.env.example` and fill in:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `SUPABASE_URL` | Supabase project URL (used to fetch JWKS for JWT verification) |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`) |
| `STRIPE_PERSONAL_PRICE_ID` | Stripe Price ID for the Personal plan |
| `SUCCESS_URL` | Redirect URL after successful Stripe payment |
| `CANCEL_URL` | Redirect URL on cancelled Stripe payment |
| `PORT` | HTTP port (default: `8080`) |

## Endpoints

All endpoints except `/billing/webhook` require `Authorization: Bearer <supabase_jwt>`.

```
POST /auth/sync-user              Create user row on first login, returns plan
GET  /accounts                    Download encrypted accounts blob
PUT  /accounts                    Upload encrypted accounts blob (last-write-wins)
POST /billing/checkout            Create Stripe Checkout session
POST /billing/webhook             Stripe webhook (no auth — verified by signature)
GET  /teams                       List user's teams
POST /teams                       Create team
GET  /teams/:id                   Team detail
DELETE /teams/:id                 Delete team (owner only)
POST /teams/:id/invite            Invite member by email
POST /teams/accept/:token         Accept invite
GET  /teams/:id/codes             List shared codes
POST /teams/:id/codes             Share a code
DELETE /teams/:id/codes/:cid      Revoke shared code
```

## Migrations

Migrations live in `migrations/` and are embedded in the binary at compile time via `sqlx::migrate!`. They run automatically on startup.

To add a new migration:

```bash
# Install sqlx-cli if needed
cargo install sqlx-cli --no-default-features --features postgres

sqlx migrate add <migration_name>
```

## Docker

```bash
# Build image
docker build -t otpilot-api .

# Or via docker-compose (from repo root)
docker compose up api --build
```

The Dockerfile uses a multi-stage build: Rust builder + minimal Debian runtime (~50MB final image).
