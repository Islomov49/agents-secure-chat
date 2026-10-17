#!/usr/bin/env bash
# Creates (once) and updates the agents-room.cc server on AWS Lightsail.
#
#   deploy/lightsail.sh up       create static IP, SSH key, instance and open ports (idempotent), then deploy
#   deploy/lightsail.sh deploy   build the image locally, copy it and the stack to the instance, restart
#   deploy/lightsail.sh ip       print the static IP (point the DNS A records of agents-room.cc here)
#   deploy/lightsail.sh ssh      open a shell on the instance
#   deploy/lightsail.sh logs     follow the containers' logs
#
# Settings (override with environment variables). Credentials come from the AWS profile.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-agents-room}"
export AWS_DEFAULT_REGION="${AWS_REGION:-eu-north-1}"
ZONE="${LIGHTSAIL_ZONE:-${AWS_DEFAULT_REGION}a}"
NAME="${LIGHTSAIL_NAME:-agents-room}"
BUNDLE="${LIGHTSAIL_BUNDLE:-medium_3_0}"      # 2 vCPU, 4 GB RAM
BLUEPRINT="${LIGHTSAIL_BLUEPRINT:-debian_12}"
SSH_USER="${LIGHTSAIL_USER:-admin}"           # "admin" on Debian, "ubuntu" on Ubuntu blueprints
KEY="${LIGHTSAIL_KEY:-$HOME/.ssh/agents_room_lightsail}"
IMAGE_TAG="ghcr.io/islomov49/agents-room-server:latest"
# AWS CLI v2 (2.32+ also supports `aws login` console credentials); v1 cannot use those.
AWS_BIN="${AWS_BIN:-$(command -v aws)}"

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
ls_() { "$AWS_BIN" lightsail "$@"; }

ip_addr() { ls_ get-static-ip --static-ip-name "$NAME-ip" --query 'staticIp.ipAddress' --output text; }
ssh_vm() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$SSH_USER@$(ip_addr)" "$@"; }

ensure_infra() {
  ls_ get-static-ip --static-ip-name "$NAME-ip" >/dev/null 2>&1 || ls_ allocate-static-ip --static-ip-name "$NAME-ip" >/dev/null
  if [ ! -f "$KEY" ]; then ssh-keygen -t rsa -b 4096 -N "" -C "$NAME-deploy" -f "$KEY" >/dev/null; fi
  ls_ get-key-pair --key-pair-name "$NAME-key" >/dev/null 2>&1 \
    || ls_ import-key-pair --key-pair-name "$NAME-key" --public-key-base64 "$(cat "$KEY.pub")" >/dev/null
  if ! ls_ get-instance --instance-name "$NAME" >/dev/null 2>&1; then
    ls_ create-instances --instance-names "$NAME" --availability-zone "$ZONE" \
      --blueprint-id "$BLUEPRINT" --bundle-id "$BUNDLE" --key-pair-name "$NAME-key" \
      --user-data '#!/bin/bash
apt-get update && apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sh
mkdir -p /opt/agents-room' >/dev/null
    echo "waiting for the instance…"
    until [ "$(ls_ get-instance-state --instance-name "$NAME" --query 'state.name' --output text)" = running ]; do sleep 5; done
    ls_ attach-static-ip --static-ip-name "$NAME-ip" --instance-name "$NAME" >/dev/null
  fi
  ls_ open-instance-public-ports --instance-name "$NAME" --port-info fromPort=443,toPort=443,protocol=TCP >/dev/null
  ls_ open-instance-public-ports --instance-name "$NAME" --port-info fromPort=443,toPort=443,protocol=UDP >/dev/null
  echo "waiting for SSH and Docker on $(ip_addr)…"
  for _ in $(seq 1 60); do
    ssh_vm "command -v docker" >/dev/null 2>&1 && return 0
    sleep 10
  done
  echo "Docker did not come up on the instance" >&2
  exit 1
}

deploy() {
  echo "building $IMAGE_TAG…"
  docker build -q -t "$IMAGE_TAG" "$repo" >/dev/null
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  docker save "$IMAGE_TAG" | gzip > "$tmp/image.tar.gz"
  scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$tmp/image.tar.gz" "$here/compose.yml" "$here/Caddyfile" "$SSH_USER@$(ip_addr):/tmp/"
  ssh_vm 'set -e
sudo mkdir -p /opt/agents-room
sudo mv /tmp/compose.yml /tmp/Caddyfile /opt/agents-room/
gunzip -c /tmp/image.tar.gz | sudo docker load >/dev/null
rm -f /tmp/image.tar.gz
cd /opt/agents-room && echo AGENTS_ROOM_IMAGE=ghcr.io/islomov49/agents-room-server:latest | sudo tee .env >/dev/null && sudo docker compose up -d --remove-orphans
sudo docker image prune -f >/dev/null'
  echo "deployed to $(ip_addr)"
}

case "${1:-}" in
  up) ensure_infra; deploy; echo "DNS: point A records for agents-room.cc and www.agents-room.cc to $(ip_addr)" ;;
  deploy) deploy ;;
  ip) ip_addr ;;
  ssh) ssh_vm ;;
  logs) ssh_vm "cd /opt/agents-room && sudo docker compose logs -f --tail 100" ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
