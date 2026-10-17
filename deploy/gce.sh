#!/usr/bin/env bash
# Creates (once) and updates the agents-room.cc VM on Google Compute Engine.
#
#   deploy/gce.sh up        create the static IP, firewall rules and VM (idempotent), then deploy
#   deploy/gce.sh deploy    build the image locally, copy it and the stack to the VM, restart
#   deploy/gce.sh ip        print the static IP (point the DNS A records of agents-room.cc here)
#   deploy/gce.sh logs      follow the VM's container logs
#
# Settings (override with environment variables):
set -euo pipefail
PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
ACCOUNT="${GCP_ACCOUNT:-$(gcloud config get-value account 2>/dev/null)}"
REGION="${GCP_REGION:-europe-north1}"
ZONE="${GCP_ZONE:-europe-north1-a}"
NAME="${VM_NAME:-agents-room}"
MACHINE="${VM_MACHINE:-e2-medium}"
DISK_GB="${VM_DISK_GB:-30}"
IMAGE_TAG="ghcr.io/islomov49/agents-room-server:latest"

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
g() { gcloud --project "$PROJECT" --account "$ACCOUNT" "$@"; }
ssh_vm() { g compute ssh "$NAME" --zone "$ZONE" --quiet --command "$1"; }

ensure_infra() {
  g services enable compute.googleapis.com >/dev/null
  g compute addresses describe "$NAME-ip" --region "$REGION" >/dev/null 2>&1 \
    || g compute addresses create "$NAME-ip" --region "$REGION"
  g compute firewall-rules describe "$NAME-web" >/dev/null 2>&1 \
    || g compute firewall-rules create "$NAME-web" --allow tcp:80,tcp:443,udp:443 --target-tags "$NAME" \
         --description "HTTP and HTTPS for $NAME"
  if ! g compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
    g compute instances create "$NAME" --zone "$ZONE" --machine-type "$MACHINE" \
      --image-family debian-12 --image-project debian-cloud --boot-disk-size "${DISK_GB}GB" --boot-disk-type pd-balanced \
      --address "$(ip_addr)" --tags "$NAME" \
      --metadata startup-script='#!/bin/bash
if ! command -v docker >/dev/null; then
  apt-get update && apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
fi
mkdir -p /opt/agents-room'
    echo "waiting for Docker on the VM…"
    for _ in $(seq 1 60); do
      ssh_vm "command -v docker" >/dev/null 2>&1 && break
      sleep 10
    done
  fi
}

ip_addr() { g compute addresses describe "$NAME-ip" --region "$REGION" --format 'value(address)'; }

deploy() {
  echo "building $IMAGE_TAG…"
  docker build -t "$IMAGE_TAG" "$repo"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  docker save "$IMAGE_TAG" | gzip > "$tmp/image.tar.gz"
  g compute scp --zone "$ZONE" --quiet "$tmp/image.tar.gz" "$here/compose.yml" "$here/Caddyfile" "$NAME:/tmp/"
  ssh_vm 'set -e
sudo mkdir -p /opt/agents-room
sudo mv /tmp/compose.yml /tmp/Caddyfile /opt/agents-room/
gunzip -c /tmp/image.tar.gz | sudo docker load
rm -f /tmp/image.tar.gz
cd /opt/agents-room && echo AGENTS_ROOM_IMAGE=ghcr.io/islomov49/agents-room-server:latest | sudo tee .env >/dev/null && sudo docker compose up -d --remove-orphans
sudo docker image prune -f >/dev/null'
  echo "deployed to $(ip_addr)"
}

case "${1:-}" in
  up) ensure_infra; deploy; echo "DNS: point A records for agents-room.cc and www.agents-room.cc to $(ip_addr)" ;;
  deploy) deploy ;;
  ip) ip_addr ;;
  logs) ssh_vm "cd /opt/agents-room && sudo docker compose logs -f --tail 100" ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
