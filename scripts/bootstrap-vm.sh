#!/bin/bash
# Run on the VM to bootstrap the shared workspace:
#   - create /opt/hackaton-the-investigator (docker-group-writable, setgid)
#   - install gh CLI if missing
#   - auth gh + git with a GitHub token read from stdin (first line)
#   - clone gigs/hackaton-the-investigator
#
# Intended invocation (from your laptop):
#   gcloud compute scp scripts/bootstrap-vm.sh hackaton-the-investigator:/tmp/bootstrap-vm.sh \
#     --tunnel-through-iap --zone=europe-west1-b --project=hackaton-the-investigator
#   gh auth token | gcloud compute ssh hackaton-the-investigator \
#     --tunnel-through-iap --zone=europe-west1-b --project=hackaton-the-investigator \
#     --command='bash /tmp/bootstrap-vm.sh && rm /tmp/bootstrap-vm.sh'
set -euo pipefail

WORKSPACE="/opt/hackaton-the-investigator"

# 1. Pull the GH token from stdin (nothing is logged; no command-line leak).
#    Tight umask only for the token read so it never lands on disk; reset
#    afterwards so the cloned repos get normal world-readable perms.
umask 077
read -r GH_TOKEN
umask 022
if [ -z "${GH_TOKEN:-}" ]; then
  echo "ERROR: no GitHub token on stdin" >&2
  exit 1
fi

# 2. Make sure this shell is in the docker group so the workspace is writable.
#    The VM startup adds the user to docker on login, but it takes a fresh
#    shell to pick it up. `sg docker` re-execs under the right group for this
#    script only.
if ! id -nG | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  exec sg docker -c "GH_TOKEN='$GH_TOKEN' $(printf '%q ' "$0" "$@")"
fi

# 3. Install gh CLI if not already.
if ! command -v gh >/dev/null 2>&1; then
  echo "==> installing gh CLI"
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
  sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq gh
fi

# 4. Auth gh + git with the token.
echo "$GH_TOKEN" | gh auth login --with-token --hostname github.com
gh auth setup-git

# 5. Shared workspace.
sudo install -d -m 2775 -g docker "${WORKSPACE}"

# 6. Clone repo (idempotent).
cd "${WORKSPACE}"
if [ -d "hackaton-the-investigator/.git" ]; then
  echo "==> hackaton-the-investigator already cloned"
else
  echo "==> cloning gigs/hackaton-the-investigator"
  gh repo clone "gigs/hackaton-the-investigator"
fi

echo
echo "==> Done. Repo in ${WORKSPACE}:"
ls -la "${WORKSPACE}"
echo
echo "Next steps:"
echo "  1. cd ${WORKSPACE}/hackaton-the-investigator"
echo "  2. ./scripts/run-app-vm.sh   (starts the app in a node:22 container)"
