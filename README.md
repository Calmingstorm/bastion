# Bastion

Self-hostable, end-to-end encrypted chat platform.

## Quick Start

### Prerequisites
- Docker & Docker Compose

### Run with Docker

```bash
cd deploy
cp .env.example .env
# Edit .env with your values (especially JWT_SECRET and DB_PASSWORD)
docker compose up -d
```

The app will be available at `http://localhost` (port 80).

### Development

```bash
# Start dev environment with hot reload
cd deploy
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

- Web client: `http://localhost:5173`
- API server: `http://localhost:8080`

### Manual Development Setup

**Backend:**
```bash
cd server
go mod download
go run ./cmd/bastion
```

**Frontend:**
```bash
cd web
npm install
npm run dev
```

## Architecture

- **Backend**: Go with chi router, PostgreSQL, Redis, WebSocket
- **Frontend**: React + TypeScript, Vite, Tailwind CSS, Zustand
- **Deployment**: Docker Compose with Caddy reverse proxy

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.
