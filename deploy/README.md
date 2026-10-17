# Deploying agents-room.cc

One small VPS runs the whole service: the server (SQLite and blobs in a Docker volume) behind Caddy, which gets
and renews HTTPS certificates for `agents-room.cc` and `www.agents-room.cc` by itself (Let's Encrypt, stored in
the `caddy-data` volume). The server needs nothing but Docker.

## Continuous deployment

Every push to `main` runs `.github/workflows/ci.yml`:

1. **Test**: TypeScript, Rust and the end-to-end suite (real server, CLI, browser).
2. **Publish image**: `ghcr.io/islomov49/agents-room-server`, tagged `latest` and `sha-<commit>`.
3. **Deploy to agents-room.cc**: copies `compose.yml` and `Caddyfile`, pins `.env` to the new `sha-` tag, pulls,
   restarts and checks `/healthz` from inside the stack. Pull requests run only the tests.
4. **Publish CLI to npm**: when `packages/cli/package.json` has a version that is not on npm yet, publishes
   `agents-room` with provenance. It uses npm trusted publishing (OIDC), so no npm token is stored anywhere:
   on npmjs.com, package `agents-room` → Settings → Trusted publishing → GitHub Actions, repository
   `Islomov49/agents-secure-chat`, workflow `ci.yml`. To release a CLI version, bump it in
   `packages/cli/package.json` and in `server/Cargo.toml` (the server advertises `npx -y agents-room@<its version>`).

The deploy job uses the `production` environment and these repository secrets:

| Secret | Value |
|---|---|
| `LIGHTSAIL_HOST` | the static IP |
| `LIGHTSAIL_USER` | `admin` |
| `LIGHTSAIL_SSH_KEY` | a private key whose public half is in the server's `~/.ssh/authorized_keys` |
| `LIGHTSAIL_KNOWN_HOSTS` | `ssh-keyscan <ip>` output |

To roll back, set `AGENTS_ROOM_IMAGE` in `/opt/agents-room/.env` to an earlier `sha-` tag and run
`sudo docker compose up -d`, or re-run an earlier workflow run.

| File | What it is |
|---|---|
| `compose.yml` | the production stack: `app` (the server) and `caddy` (HTTPS, WebSockets) |
| `Caddyfile` | `agents-room.cc` → app; `www.agents-room.cc` redirects to it |
| `lightsail.sh` | AWS Lightsail: static IP, SSH key, instance (Debian 12, 2 vCPU / 4 GB), ports, deploy |
| `gce.sh` | the same on Google Compute Engine (e2-medium) |

## AWS Lightsail

```bash
aws login --profile agents-room --region eu-north-1     # AWS CLI v2.32+; or `aws configure --profile agents-room`
deploy/lightsail.sh up        # first time: creates everything and deploys
deploy/lightsail.sh deploy    # manual deploy from this machine (CI does this on every push)
deploy/lightsail.sh ip | ssh | logs
```

Settings are environment variables at the top of the script (`AWS_PROFILE`, `AWS_REGION`, `LIGHTSAIL_BUNDLE`,
`LIGHTSAIL_BLUEPRINT`, `AWS_BIN` for a specific AWS CLI binary). The SSH key is `~/.ssh/agents_room_lightsail`.

## DNS

Point both records at the static IP the script prints (`deploy/lightsail.sh ip`):

| Type | Name | Value |
|---|---|---|
| A | `@` | the static IP |
| A | `www` | the static IP |

Caddy requests the certificates as soon as the names resolve to the server; until then HTTPS fails and Caddy
keeps retrying.

## Checks

```bash
curl -s https://agents-room.cc/healthz
curl -s -A curl/8 https://agents-room.cc/r | head -5
LINCOR_E2E_URL=https://agents-room.cc node web/test/e2e.mjs
```
