#!/usr/bin/env bash
# Runs as root inside the builder VM (see build.sh) and turns the Ubuntu 24.04
# desktop image into the image every session starts from (SANDBOX_BUILD_NAME).
#
# Each session VM is driven by an agent that sets up a GitHub repo and leaves a
# running demo for a human, who watches it in the browser. So the image has:
#   - runtimes and system tools a repo can't install itself without sudo
#   - Playwright + Chromium, so the agent can check a page before calling it ready
#   - a `demo` systemd service, so the demo keeps running after the agent stops
#   - an X11 desktop that logs in by itself, served to the browser by noVNC
#     (xdotool and scrot only work on X11, not Wayland)
#
# Dependencies come in three layers:
#   1. system     compilers, libraries, tools, VS Code     apt / official installers
#   2. common     Python packages for quick scripts         shared venv SANDBOX_VM_PY_VENV
#   3. per repo   whatever a repo needs                     the repo's own .venv / node_modules
# This script does layers 1 and 2, and warms the download caches for layer 3.
#
# Ports inside the VM:
#   SANDBOX_VM_NOVNC_PORT   noVNC: the desktop in the browser (http://<vm>:<port>/vnc.html)
#   SANDBOX_VM_VNC_PORT     VNC, only on localhost (noVNC talks to it)
#
# Paths, ports and versions come in as SANDBOX_VM_* environment variables from
# build.sh (which reads them from the project's .env).

set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

NODE_MAJOR=$SANDBOX_VM_NODE_MAJOR
FALLBACK_USER=$SANDBOX_VM_FALLBACK_USER
PY_VENV=$SANDBOX_VM_PY_VENV
RUST_DIR=$SANDBOX_VM_RUST_DIR
PLAYWRIGHT_DIR=$SANDBOX_VM_PLAYWRIGHT_DIR
DEMO_DIR=$SANDBOX_VM_DEMO_DIR
NOVNC_PORT=$SANDBOX_VM_NOVNC_PORT
VNC_PORT=$SANDBOX_VM_VNC_PORT
DOCKER_IMAGES=$SANDBOX_VM_DOCKER_IMAGES

# The desktop updates itself on first boot; wait for its apt lock instead of failing.
APT="apt-get -y -o DPkg::Lock::Timeout=900"
PATH_ALL="$PY_VENV/bin:/usr/local/go/bin:$RUST_DIR/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"

cloud-init status --wait || true

# The desktop user: uid 1000 if the image has one, otherwise we make FALLBACK_USER.
desktop_user=$(id -nu 1000 2>/dev/null || true)
if [[ -z "$desktop_user" ]]; then
    useradd --create-home --uid 1000 --shell /bin/bash "$FALLBACK_USER"
    desktop_user=$FALLBACK_USER
fi
desktop_home=$(getent passwd "$desktop_user" | cut -d: -f6)
usermod -aG sudo "$desktop_user"
echo "$desktop_user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-desktop-user
chmod 440 /etc/sudoers.d/90-desktop-user

# --- 1. System packages -----------------------------------------------------

$APT update
$APT upgrade
$APT install --no-install-recommends \
    build-essential ca-certificates curl wget git git-lfs gnupg jq \
    less nano unzip zip xz-utils file tree ripgrep htop tmux \
    procps psmisc lsof iproute2 iputils-ping dnsutils \
    pkg-config libssl-dev libffi-dev zlib1g-dev libsqlite3-dev libpq-dev \
    libbz2-dev libreadline-dev liblzma-dev sqlite3 \
    python3 python3-dev python3-venv python3-pip pipx \
    openjdk-21-jdk \
    docker.io docker-compose-v2 docker-buildx \
    ffmpeg imagemagick poppler-utils graphviz postgresql-client redis-tools \
    xdotool scrot x11vnc novnc python3-websockify

# VS Code. Its package adds Microsoft's apt repo itself, so it updates with apt.
echo "code code/add-microsoft-repo boolean true" | debconf-set-selections
curl -fsSL "https://code.visualstudio.com/sha/download?build=stable&os=linux-deb-x64" -o /tmp/code.deb
$APT install /tmp/code.deb
rm /tmp/code.deb

# Node.js: the current LTS line, from nodejs.org (checksum verified).
node_base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
node_file=$(curl -fsSL "$node_base/SHASUMS256.txt" | awk '/linux-x64\.tar\.xz$/ {print $2}')
curl -fsSL "$node_base/$node_file" -o "/tmp/$node_file"
(cd /tmp && curl -fsSL "$node_base/SHASUMS256.txt" | grep " $node_file\$" | sha256sum -c -)
tar -xJf "/tmp/$node_file" -C /usr/local --strip-components=1 --no-same-owner
rm "/tmp/$node_file"
corepack enable  # pnpm and yarn, at the version a project's package.json asks for

# fnm: other Node versions when a repo asks for them (.nvmrc, engines), e.g. `fnm use 20`.
curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir /usr/local/bin --skip-shell

# Go: the latest release from go.dev (apt's is old).
go_version=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1)
curl -fsSL "https://go.dev/dl/${go_version}.linux-amd64.tar.gz" -o /tmp/go.tar.gz
rm -rf /usr/local/go
tar -xzf /tmp/go.tar.gz -C /usr/local
rm /tmp/go.tar.gz

# Rust: toolchain in RUST_DIR for everyone. Each user's crates go in ~/.cargo.
curl -fsSL https://sh.rustup.rs | env RUSTUP_HOME="$RUST_DIR" CARGO_HOME="$RUST_DIR/cargo" \
    sh -s -- -y --no-modify-path --profile minimal
chmod -R a+rX "$RUST_DIR"

# uv: Python projects and Python versions (e.g. `uv venv --python 3.10`).
curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh

# Playwright + headless Chromium in PLAYWRIGHT_DIR, for the agent's page checks.
mkdir -p "$PLAYWRIGHT_DIR"
(
    cd "$PLAYWRIGHT_DIR"
    npm init -y >/dev/null
    npm install --no-audit --no-fund playwright@1
    PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_DIR/browsers" npx playwright install --with-deps --only-shell chromium
)
chmod -R a+rX "$PLAYWRIGHT_DIR"

# Databases most full-stack demos need, already pulled (run them with Docker).
systemctl start docker
for docker_image in $DOCKER_IMAGES; do
    docker pull "$docker_image"
done

# --- 2. Common Python packages ----------------------------------------------

# Ubuntu blocks `pip install` into the system Python, so the common packages go
# in a shared venv that is first on PATH. --seed puts pip in it.
uv venv "$PY_VENV" --python /usr/bin/python3 --seed
uv pip install --python "$PY_VENV/bin/python" -r /root/python-packages.txt
# One user per VM: let them pip install into it without sudo.
chmod -R a+rwX "$PY_VENV"

# --- Environment for everyone -----------------------------------------------

# Read at login (desktop session and terminals started from it).
cat > /etc/environment <<EOF
PATH="$PATH_ALL"
RUSTUP_HOME="$RUST_DIR"
PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_DIR/browsers"
EOF

# The desktop user may use Docker without sudo.
usermod -aG docker "$desktop_user"

# --- Desktop: X11, logs in by itself, never locks ----------------------------

cat > /etc/gdm3/custom.conf <<EOF
[daemon]
WaylandEnable=false
AutomaticLoginEnable=true
AutomaticLogin=$desktop_user
EOF

mkdir -p /etc/dconf/profile /etc/dconf/db/local.d
cat > /etc/dconf/profile/user <<'EOF'
user-db:user
system-db:local
EOF
cat > /etc/dconf/db/local.d/00-sandbox <<'EOF'
[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/screensaver]
lock-enabled=false

[org/gnome/desktop/lockdown]
disable-lock-screen=true
EOF
dconf update

# --- Desktop in the browser: x11vnc + noVNC -----------------------------------

# x11vnc starts inside the desktop session, so it gets the right display.
# Only on localhost; noVNC is the way in from outside.
cat > /etc/xdg/autostart/x11vnc.desktop <<EOF
[Desktop Entry]
Type=Application
Name=x11vnc
Exec=x11vnc -forever -shared -nopw -localhost -rfbport $VNC_PORT -noxdamage
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF

cat > /etc/systemd/system/novnc.service <<EOF
[Unit]
Description=noVNC: the desktop in the browser
After=network.target

[Service]
ExecStart=/usr/bin/websockify --web /usr/share/novnc $NOVNC_PORT localhost:$VNC_PORT
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl enable novnc.service

# --- The demo service ---------------------------------------------------------

# The agent writes the start command to DEMO_DIR/run.sh, then runs
# `sudo systemctl enable --now demo` (or restart). It survives the agent's
# shell ending and VM restarts. Logs: `journalctl -u demo`.
mkdir -p "$DEMO_DIR"
cat > "$DEMO_DIR/run.sh" <<'EOF'
#!/usr/bin/env bash
echo "No demo yet: the agent writes the start command here."
exit 1
EOF
chmod 755 "$DEMO_DIR/run.sh"
chown -R "$desktop_user:$desktop_user" "$DEMO_DIR"

cat > /etc/systemd/system/demo.service <<EOF
[Unit]
Description=The repo's demo, started by the agent
After=network-online.target docker.service

[Service]
User=$desktop_user
WorkingDirectory=$desktop_home
Environment=PATH=$PATH_ALL
Environment=RUSTUP_HOME=$RUST_DIR
Environment=PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_DIR/browsers
ExecStart=$DEMO_DIR/run.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# --- Warm the download caches for common project packages --------------------

# Repos still install their own pinned versions; these just make the first
# install in a session faster. Run as the desktop user so the caches are theirs.
sudo -u "$desktop_user" -H npm cache add \
    react react-dom next vite @vitejs/plugin-react typescript tailwindcss \
    @tailwindcss/vite eslint express
sudo -u "$desktop_user" -H uv pip install --target /tmp/uv-warm \
    fastapi "uvicorn[standard]" pydantic sqlalchemy httpx flask django
rm -rf /tmp/uv-warm

# --- Clean up before publishing ---------------------------------------------

$APT clean
uv cache clean  # root's cache only; the desktop user's warm cache stays
rm -rf /root/provision.sh /root/python-packages.txt /tmp/*
# Each VM made from the image gets its own machine-id on first boot, so
# copies don't look like the same machine on the network (DHCP).
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
# Give freed blocks back, so the published image is smaller.
fstrim -av || true
