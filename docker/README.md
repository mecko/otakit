# Self-hosting OtaKit

Console (dashboard + API), Postgres and [RustFS](https://github.com/rustfs/rustfs)
(S3 storage, serves bundles) with Docker Compose.

## Quick start

```bash
mkdir otakit && cd otakit
curl -fsSLO https://raw.githubusercontent.com/mecko/otakit/main/docker/compose.yaml
# Writes .env with secrets and a signing key; never overwrites an existing one.
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/mecko/otakit-console node /app/docker/init-env.mjs
docker compose up -d
```

1. Open <http://localhost:3000> and sign in by email. Without Resend, the code is in
   `docker compose logs console | grep "Your code"`.
2. Create an app and an API token.
3. Paste the `capacitor.config.ts` block `init-env.mjs` printed, then:

   ```bash
   OTAKIT_SERVER_URL=http://localhost:3000 OTAKIT_TOKEN=otakit_sk_... npx @otakit/cli upload --release
   ```

Ports 3000 (console), 9000 (S3) and 8787 (events) listen on `127.0.0.1`.
Anonymous S3 access is `GET` only, under `manifests/`, `bundles/` and `files/`.

## Going public

Put a TLS proxy in front and set `OTAKIT_URL` / `OTAKIT_S3_URL` to the `https://`
origins. Or use Cloudflare Tunnel:

1. Put the tunnel token in `CLOUDFLARE_TUNNEL_TOKEN`.
2. Route `console.example.com` → `http://console:3000` and `s3.example.com` → `http://rustfs:9000`
   (no Host header override).
3. Set `OTAKIT_URL` / `OTAKIT_S3_URL` to them; use them as `serverUrl` / `cdnUrl` in the app.
4. `docker compose --profile tunnel up -d`

Turn off Bot Fight Mode and challenges for both hostnames, and don't cache
`manifests/`. Free and Pro plans cap uploads at 100 MB.

## Configuration

In `.env` ([`.env.example`](.env.example)):

- **OAuth:** `GITHUB_CLIENT_ID`/`_SECRET`, `GOOGLE_CLIENT_ID`/`_SECRET`; callback `${OTAKIT_URL}/api/auth/callback/github`.
- **Email:** `RESEND_API_KEY`, `EMAIL_FROM`.
- **Phone on LAN:** `OTAKIT_BIND_ADDRESS` = your LAN IP, also in both URLs and `cdnUrl`.
- **Other console origin:** rebuild with `--build-arg NEXT_PUBLIC_APP_URL=...` and set
  `OTAKIT_IMAGE` (only affects the agent-connect snippets).

No billing.

## Device events

Always set `ingestUrl` in the app (with the tunnel: `events.example.com` →
`http://ingest:8787`, then `ingestUrl: "https://events.example.com/v1"`).
Without it, devices send events to the hosted `ingest.otakit.app`.

- **Off (default):** `ingest` logs each event and discards it.
- **On:** analytics, download counts and release health (needed by auto-revert)
  via Tinybird Local. Needs 8 GB RAM. Run `init-env.mjs` with `--events`, then
  `docker compose up -d`. Events are kept 90 days.

To turn it off again: remove `events` from `COMPOSE_PROFILES`, empty both
`TINYBIRD_*` tokens (keep a copy for re-enabling), then
`docker compose --profile events rm -sf tinybird && docker compose up -d`.

## Operations

```bash
docker compose pull && docker compose up -d                          # upgrade
docker compose exec postgres pg_dump -U otakit otakit > otakit.sql   # back up the database
docker compose exec rustfs du -sh /data                              # storage usage
docker compose down -v                                               # DELETE all data
```

Back up `.env` with the volumes. Losing the signing key means devices reject new
manifests until a native update ships a new `manifestKeys` entry.

[CI](../.github/workflows/docker.yml) publishes `ghcr.io/mecko/otakit-console`
(amd64/arm64) on pushes to `main` and `v*` tags.
