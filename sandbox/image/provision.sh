#!/usr/bin/env bash
# Runs as root inside the builder VM (see build.sh) and turns a fresh Ubuntu
# 24.04 into the sandbox base image. What it sets up is what the setup agent's
# system prompt promises (sandbox/setup_agent.py) and what sandbox/vm.py relies
# on: the user `dev`, /home/dev/project, the editor and terminal ports, the
# `demo` service and /opt/sandbox/check-page.mjs. Change them together.

set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

EDITOR_PORT=13337
TERMINAL_PORT=13338
NODE_MAJOR=24

cloud-init status --wait || true

# --- Packages ---------------------------------------------------------------

apt-get update
apt-get install -y --no-install-recommends software-properties-common
add-apt-repository -y universe
apt-get update
apt-get -y upgrade
apt-get install -y --no-install-recommends \
    build-essential ca-certificates cloud-guest-utils curl wget git git-lfs gnupg jq \
    less nano vim-tiny unzip zip xz-utils file tree ripgrep \
    procps psmisc lsof iproute2 iputils-ping dnsutils htop \
    pkg-config libssl-dev libffi-dev zlib1g-dev libsqlite3-dev libpq-dev sqlite3 \
    python3 python3-dev python3-venv python3-pip pipx \
    docker.io docker-compose-v2 docker-buildx \
    sudo locales

# Node.js: the current LTS line, from nodejs.org (checksum verified).
node_base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
node_file=$(curl -fsSL "$node_base/SHASUMS256.txt" | awk '/linux-x64\.tar\.xz$/ {print $2}')
curl -fsSL "$node_base/$node_file" -o "/tmp/$node_file"
(cd /tmp && curl -fsSL "$node_base/SHASUMS256.txt" | grep " $node_file\$" | sha256sum -c -)
tar -xJf "/tmp/$node_file" -C /usr/local --strip-components=1 --no-same-owner
rm "/tmp/$node_file"
corepack enable  # pnpm and yarn, at the version a project's package.json asks for

# uv (Python projects and Python versions).
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

# code-server: VS Code in the browser.
curl -fsSL https://code-server.dev/install.sh | sh

# ttyd: a terminal in the browser.
curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /usr/local/bin/ttyd
chmod 755 /usr/local/bin/ttyd

# Headless Chromium for the agent's check_app tool.
mkdir -p /opt/sandbox
mv /root/check-page.mjs /opt/sandbox/check-page.mjs
(
    cd /opt/sandbox
    npm init -y >/dev/null
    npm install --no-audit --no-fund playwright@1
    PLAYWRIGHT_BROWSERS_PATH=/opt/sandbox/browsers npx playwright install --with-deps --only-shell chromium
)
chmod -R a+rX /opt/sandbox

systemctl enable docker

# --- The dev user -------------------------------------------------------------

useradd --create-home --shell /bin/bash --groups sudo,docker,systemd-journal dev
echo "dev ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/dev
chmod 440 /etc/sudoers.d/dev

# Nothing may wait for input: the agent's commands have no keyboard.
cat >/etc/profile.d/sandbox.sh <<'EOF'
export GIT_TERMINAL_PROMPT=0
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export PIP_NO_INPUT=1
export npm_config_yes=true
EOF

sudo -u dev git config --global user.name "Sandbox"
sudo -u dev git config --global user.email "dev@sandbox.localhost"
sudo -u dev git config --global init.defaultBranch main
sudo -u dev mkdir -p /home/dev/project /home/dev/.sandbox
sudo -u dev touch /home/dev/.sudo_as_admin_successful  # No sudo hint in every new terminal.

# --- Web editor and terminal ---------------------------------------------------

# Only reachable through the backend's preview proxy, which listens on 127.0.0.1.
sudo -u dev mkdir -p /home/dev/.config/code-server /home/dev/.local/share/code-server/User
cat >/home/dev/.config/code-server/config.yaml <<EOF
bind-addr: 0.0.0.0:$EDITOR_PORT
auth: none
cert: false
disable-telemetry: true
disable-update-check: true
disable-workspace-trust: true
disable-getting-started-override: true
EOF
cat >/home/dev/.local/share/code-server/User/settings.json <<'EOF'
{
  "window.autoDetectColorScheme": true,
  "workbench.startupEditor": "none",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "chat.disableAIFeatures": true,
  "telemetry.telemetryLevel": "off",
  "security.workspace.trust.enabled": false
}
EOF
chown -R dev:dev /home/dev/.config /home/dev/.local
systemctl enable code-server@dev

cat >/etc/systemd/system/terminal.service <<EOF
[Unit]
Description=Web terminal (ttyd)
After=network.target

[Service]
User=dev
Group=dev
WorkingDirectory=/home/dev/project
# --check-origin: only pages served by this same address may open a terminal.
ExecStart=/usr/local/bin/ttyd --port $TERMINAL_PORT --writable --check-origin bash -l
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl enable terminal

# --- The demo service -------------------------------------------------------------

# The agent's start_app tool writes /home/dev/.sandbox/demo.sh, then enables and
# (re)starts this service.
cat >/etc/systemd/system/demo.service <<'EOF'
[Unit]
Description=Demo app set up by the agent (command: /home/dev/.sandbox/demo.sh)
After=network-online.target docker.service
Wants=network-online.target
ConditionPathExists=/home/dev/.sandbox/demo.sh

[Service]
User=dev
Group=dev
ExecStart=/home/dev/.sandbox/demo.sh
Restart=on-failure
RestartSec=5
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

# --- Clean up, so every sandbox starts fresh ------------------------------------------

apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /root/provision.sh
# A new machine-id, SSH host keys and a resized disk on each sandbox's first boot.
cloud-init clean --logs --machine-id
fstrim -av || true
