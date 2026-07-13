# Bastion

A self-hostable, open-source chat platform built for communities. Real-time text chat with servers, channels, direct messages, roles, moderation, and more.

## Features

**Messaging**
- Real-time text chat via WebSocket
- Markdown rendering with syntax-highlighted code blocks, spoiler tags, and @mentions
- Message editing, deletion, and reply threads
- Emoji reactions
- File uploads with drag-and-drop, paste, and image previews
- GIF picker with Tenor or Giphy search (optional, requires API key)
- Image/GIF URL embeds (Tenor, Giphy, direct image links)
- Full-text message search (Ctrl+K)
- Browser notifications on @mention

**Servers & Channels**
- Create and join servers via invite links
- Text channels with topics, organized into collapsible categories
- Direct messages (1:1 and group)
- Channel drag-and-drop reordering
- Typing indicators and online/offline/idle/DND presence
- Message pinning

**Roles & Permissions**
- Custom roles with colors and granular bitfield permissions
- Role hierarchy with position-based authority
- Channel permission overrides (per-role and per-member)
- Default @bastion role for new members

**Moderation**
- Kick, ban/unban, and timeout with duration
- Audit log tracking all admin actions
- Message deletion by moderators (MANAGE_MESSAGES permission)

**User Accounts**
- Email/password registration and login
- JWT authentication with automatic token refresh
- Password reset via email (Mailgun or SMTP)
- User profiles with avatars, display names, about me, and custom status
- Account management: change password, change email, delete account
- Server nicknames

**Infrastructure**
- Versioned REST API (`/api/v1/`) with backward-compatible redirects
- Rate limiting: auth (5/min), messages (10/10s), uploads (5/min), general (120/min)
- Structured error responses with machine-readable error codes
- WebSocket reconnection with automatic data resync
- [WebSocket protocol documentation](docs/websocket-protocol.md)

## Clients

Bastion has native clients for all major platforms, built with [Tauri](https://tauri.app/). All clients share the same `web/src/` codebase.

| Platform | Download | Notes |
|----------|----------|-------|
| Web | [intolerable.cc](https://intolerable.cc) | No install needed |
| Linux | [.deb / .rpm / .AppImage](https://github.com/Calmingstorm/bastion/releases/tag/desktop-linux-v0.1.1) | |
| Windows | [.exe installer](https://github.com/Calmingstorm/bastion/releases/tag/desktop-windows-v0.1.1) | |
| macOS | [.dmg](https://github.com/Calmingstorm/bastion/releases/tag/desktop-macos-v0.1.1) | Apple Silicon, unsigned — right-click → Open on first launch |
| Android | [.apk](https://github.com/Calmingstorm/bastion/releases/tag/android-v0.1.3) | Unsigned — enable "Install from unknown sources" |
| iOS | — | Blocked on Apple Developer account |

## Quick Start

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

### Deploy with Docker

```bash
git clone https://github.com/Calmingstorm/bastion.git
cd bastion/deploy

# Create your environment file
cp .env.example .env
```

Edit `.env` and set at minimum:
- `DB_PASSWORD` — a strong random password
- `JWT_SECRET` — a long random string (e.g. `openssl rand -base64 48`)
- `BASTION_DOMAIN` — your domain or `http://localhost` for local use
- `BASTION_TRUSTED_PROXIES` — the reverse-proxy source network(s) whose
  `X-Forwarded-For` may be trusted for rate limiting. The provided
  `docker-compose.yml` pins the `bastion` subnet, so the default
  `172.28.0.0/16` is correct for that stack. Leave it empty if you expose the
  server directly without a proxy.

Then update `Caddyfile` (copy from `Caddyfile.example`) and replace `YOUR_DOMAIN` with your domain.

```bash
cp Caddyfile.example Caddyfile
# Edit Caddyfile — replace YOUR_DOMAIN with your actual domain

docker compose up -d
```

Bastion will be available at your configured domain. Caddy handles TLS automatically.

Database migrations run automatically on first startup — no manual SQL required.

### Optional Features

These are configured via environment variables in `.env`. See `.env.example` for all options.

| Feature | Variable | Notes |
|---------|----------|-------|
| Password reset emails | `BASTION_MAILGUN_*` or `BASTION_SMTP_*` | Mailgun HTTP API or any SMTP server |
| GIF picker | `BASTION_TENOR_API_KEY` | Free Tenor API key from [Google Cloud](https://developers.google.com/tenor/guides/quickstart) |
| GIF picker (alt) | `BASTION_GIPHY_API_KEY` | Free Giphy API key from [Giphy Developers](https://developers.giphy.com/dashboard/?create=true). Configure one of Tenor or Giphy — if both are set, Tenor is used. |

Features that aren't configured are gracefully hidden from the UI.

## Development

### Docker (recommended)

```bash
cd deploy
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

- Web client with hot reload: `http://localhost:5173`
- API server with live rebuild: `http://localhost:8080`

### Manual Setup

Requires Go 1.23+, Node.js 22+, PostgreSQL 16, and Redis 7.

**Backend:**
```bash
cd server
go mod download
# Set DB/Redis env vars (see .env.example), then:
go run ./cmd/bastion
```

**Frontend:**
```bash
cd web
npm install
npm run dev
```

### Testing

The server has unit tests (pure logic, always run) and integration tests that
exercise the real HTTP API against a throwaway PostgreSQL and Redis. The
integration tests are gated on `TEST_DATABASE_URL` and `TEST_REDIS_ADDR`; when
unset they skip, so `go test ./...` stays green without the services.

```bash
cd server
make test        # starts Docker Postgres+Redis, runs the whole suite
make test-race   # same, with the race detector
make unit        # only the always-on unit tests (no Docker needed)
make test-down   # remove the throwaway services
make lint        # golangci-lint
```

CI runs the full suite with `-race` against Postgres/Redis service containers,
plus `gofmt`, `go vet`, and a golangci-lint ratchet (fails only on newly
introduced findings; see `server/.golangci.yml`).

## Architecture

```
bastion/
├── server/              # Go backend
│   ├── cmd/bastion/     # Entry point
│   ├── internal/
│   │   ├── api/         # HTTP/WS handlers, router
│   │   ├── auth/        # JWT middleware
│   │   ├── config/      # Environment-based config
│   │   ├── database/    # PostgreSQL pool, migrations
│   │   ├── email/       # SMTP + Mailgun
│   │   ├── models/      # Data structures
│   │   ├── permissions/ # Bitfield permission engine
│   │   ├── realtime/    # WebSocket hub + client
│   │   └── storage/     # File upload handling
│   └── migrations/      # SQL migrations (auto-applied)
├── web/                 # React web client (shared by all platforms)
│   └── src/
│       ├── api/         # Axios client, WebSocket client
│       ├── components/  # UI components
│       ├── hooks/       # React hooks
│       ├── pages/       # Route pages
│       ├── platform/    # Platform adapters (web, desktop, mobile)
│       ├── stores/      # Zustand state management
│       ├── utils/       # Permissions, storage, event bus, errors
│       └── styles/      # CSS
├── desktop/             # Tauri desktop wrapper (Linux, Windows, macOS)
│   └── src-tauri/       # Rust/Tauri config
├── android/             # Tauri mobile wrapper (Android)
│   └── src-tauri/       # Rust/Tauri config
├── ios/                 # Tauri mobile wrapper (iOS, not yet buildable)
│   └── src-tauri/       # Rust/Tauri config
├── docs/                # Protocol and API documentation
└── deploy/              # Docker Compose, Dockerfiles, Caddy
```

**Backend**: Go, chi v5 router, pgx v5 (PostgreSQL), Redis, WebSocket (coder/websocket), httprate, zerolog, golang-migrate

**Frontend**: React 19, TypeScript, Vite 6, Tailwind CSS 4, Zustand 5, Axios, Radix UI, markdown-it, highlight.js

**Infrastructure**: Docker Compose, multi-stage builds, Caddy reverse proxy with automatic TLS

## Database

Bastion uses PostgreSQL 16 with automatic schema migrations. On startup, the server applies all pending migrations from `server/migrations/` in order. A fresh database is fully provisioned automatically — no manual SQL or seed scripts needed.

Migrations are embedded into the Go binary at compile time, so they work in both development and Docker deployments.

## API

All endpoints are under `/api/v1/`. Authentication uses Bearer JWT tokens. Requests to the legacy `/api/*` prefix are automatically redirected to `/api/v1/*`.

See the full endpoint list in the [project documentation](https://bastions.org) (coming soon) or browse `server/internal/api/router.go` for the complete route table.

Key public endpoints:
- `GET /api/v1/features` — feature flags (which optional features are enabled)
- `POST /api/v1/auth/register` — create account
- `POST /api/v1/auth/login` — sign in
- `GET /api/v1/ws` — WebSocket connection (authenticated)

Error responses use structured format: `{"error": {"code": "ERROR_CODE", "message": "..."}}`

For WebSocket protocol details (events, heartbeat, reconnection), see [docs/websocket-protocol.md](docs/websocket-protocol.md).

## License

[AGPL-3.0](LICENSE) — you can use, modify, and self-host freely. If you distribute a modified version as a network service, you must share your source code under the same license.
