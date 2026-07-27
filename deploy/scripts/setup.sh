#!/usr/bin/env bash
# Initial server setup for Pauken on Debian.
# Run as root once on a fresh Debian server.

set -euo pipefail

echo "==> Updating system packages..."
apt update && apt upgrade -y

echo "==> Installing dependencies..."
apt install -y \
  nodejs \
  npm \
  postgresql \
  nginx \
  certbot \
  python3-certbot-nginx \
  rsync

echo "==> Creating pauken user..."
id -u pauken &>/dev/null || useradd -r -s /bin/false -m -d /opt/pauken pauken

echo "==> Setting up Postgres..."
su - postgres -c "createuser pauken || true"
su - postgres -c "createdb -O pauken pauken || true"
su - postgres -c "psql -c \"ALTER USER pauken WITH PASSWORD 'pauken'\"" || true

echo "==> Creating directory structure..."
mkdir -p /opt/pauken
mkdir -p /etc/pauken
mkdir -p /var/backups/pauken

echo "==> Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Copy deploy/users.example.json to /etc/pauken/users.json and set keys"
echo "  2. Copy deploy/env.template to /opt/pauken/.env and configure"
echo "  3. Copy deploy/nginx/pauken.conf to /etc/nginx/sites-available/"
echo "  4. Run certbot to get SSL certificates"
echo "  5. Copy deploy/systemd/*.service to /etc/systemd/system/"
echo "  6. Run 'npm run build' in /opt/pauken"
echo "  7. Run 'systemctl enable --now pauken-api'"
echo "  8. Copy deploy/scripts/backup.sh to /etc/cron.daily/pauken-backup"
