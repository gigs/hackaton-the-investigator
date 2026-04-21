#!/bin/bash
# VM startup script: install Docker (with compose plugin) + git
# Runs as root via cloud-init on first boot.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git gnupg make

# Docker official repo
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

# Let any OS Login / project-SSH user run docker without sudo.
# Apply to the primary non-root user after they log in via a login hook.
cat >/etc/profile.d/99-docker-group.sh <<'EOF'
# Add the current interactive user to the docker group once, then prompt relogin.
if [ -n "${USER:-}" ] && [ "$USER" != "root" ] && id -nG "$USER" | grep -qv '\bdocker\b'; then
  sudo usermod -aG docker "$USER" || true
fi
EOF
chmod +x /etc/profile.d/99-docker-group.sh

echo "VM startup complete: docker + git installed" > /var/log/vm-startup-done
