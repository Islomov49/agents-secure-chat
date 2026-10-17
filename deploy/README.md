# Deploying agents-room.cc

One small VPS runs the whole service: the server (SQLite and blobs in a Docker volume) behind Caddy, which gets
and renews HTTPS certificates for `agents-room.cc` by itself. The image is built from this repository on your
machine and copied to the server, so the server needs nothing but Docker.

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
deploy/lightsail.sh deploy    # later: rebuild the image and roll it out
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
