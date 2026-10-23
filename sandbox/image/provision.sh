#!/usr/bin/env bash
# Runs as root inside the builder VM (see build.sh) and turns the Ubuntu 24.04
# desktop image into the image every session starts from (SANDBOX_BUILD_NAME).
#
# Each session VM is driven by an agent that sets up a GitHub repo and leaves a
# running demo for a human, who watches it in the browser. So the image has:
#   - runtimes and system tools a repo can't install itself without sudo
#   - Playwright + Chromium, so the agent can check a page before calling it ready
#   - Flatpak (with Flathub) and Firefox from it, pinned to the dock with Files and Terminal
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
#   SANDBOX_VM_TERMINAL_PORT  ttyd: terminals in the browser (http://<vm>:<port>/?arg=<n>)
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
TERMINAL_PORT=$SANDBOX_VM_TERMINAL_PORT
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
    xdotool scrot x11vnc novnc python3-websockify ttyd

# VS Code. Its package adds Microsoft's apt repo itself, so it updates with apt.
echo "code code/add-microsoft-repo boolean true" | debconf-set-selections
curl -fsSL "https://code.visualstudio.com/sha/download?build=stable&os=linux-deb-x64" -o /tmp/code.deb
$APT install /tmp/code.deb
rm /tmp/code.deb

# Flatpak with Flathub, and Firefox from it for everyone (a browser on the desktop
# for the human and the agent). No snap Firefox next to it, so there is only one.
$APT install flatpak
flatpak remote-add --system --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --system -y --noninteractive flathub org.mozilla.firefox
if command -v snap > /dev/null && snap list firefox > /dev/null 2>&1; then
    snap remove --purge firefox
fi

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
TIKTOKEN_CACHE_DIR="$desktop_home/.cache/tiktoken"
EOF

# The desktop user may use Docker without sudo.
usermod -aG docker "$desktop_user"

# The desktop's network is run by NetworkManager. systemd-networkd manages no
# link, so its wait-online job only holds up every boot for its 2 minute timeout.
systemctl mask systemd-networkd-wait-online.service

# --- Quiet desktop: no welcome wizard, no Ubuntu Pro, no update or crash popups --

# gnome-initial-setup is the "Welcome to Ubuntu" wizard (privacy, location,
# Ubuntu Pro pages) on first login. update-notifier opens Software Updater and
# its Ubuntu Pro offers. apport and whoopsie pop up crash reports.
# unattended-upgrades runs apt in the background and holds its lock while a
# session installs things. Sessions are throwaway VMs; none of these help.
# Purging them also removes the ubuntu-desktop-minimal meta-package, which would
# let a later `apt autoremove` strip out the desktop. So first mark everything
# installed as wanted on its own, and never autoremove here.
apt-mark showauto | xargs apt-mark manual > /dev/null
$APT purge gnome-initial-setup update-notifier apport whoopsie unattended-upgrades
# In case anything still looks for it: first-login setup is done.
mkdir -p "$desktop_home/.config"
echo yes > "$desktop_home/.config/gnome-initial-setup-done"
chown -R "$desktop_user:$desktop_user" "$desktop_home/.config"
# Ubuntu Pro adverts in apt output and the login message.
pro config set apt_news=false || true
rm -f /etc/apt/apt.conf.d/20apt-esm-hook.conf
if [[ -f /etc/default/motd-news ]]; then
    sed -i 's/^ENABLED=.*/ENABLED=0/' /etc/default/motd-news
fi

# --- No shadow stacks: they crash the whole VM on this host ------------------

# When a program turns on a user shadow stack (a CPU security feature), the VM's
# CPU keeps it on for the programs after it, and they all crash at once, systemd
# too, so the VM freezes. fwupd does it when it starts. clearcpuid stops any
# program from turning shadow stacks on, and a VM has no firmware to update.
# The backend also does this on every start (VM.guard_shadow_stack in sandbox/vm.py).
systemctl mask fwupd.service fwupd-refresh.service fwupd-refresh.timer
echo 'GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT clearcpuid=user_shstk"' > /etc/default/grub.d/99-sandbox-no-shadow-stack.cfg
update-grub

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

[org/gnome/shell]
favorite-apps=['org.mozilla.firefox.desktop', 'org.gnome.Nautilus.desktop', 'org.gnome.Terminal.desktop']
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

# --- Terminals in the browser: ttyd + tmux ------------------------------------

# Each terminal tab opens http://<vm>:<port>/?arg=<n> and gets tmux session <n>
# as the desktop user. Closing the browser tab leaves the session running;
# `tmux kill-session -t <n>` (the backend does it when a tab is closed) stops it.
cat > /usr/local/bin/sandbox-terminal <<'EOF'
#!/usr/bin/env bash
name="${1:-1}"
if [[ ! "$name" =~ ^[0-9]{1,4}$ ]]; then
    echo "Terminal names are numbers."
    exit 1
fi
user=$(id -nu 1000)
exec runuser -l "$user" -c "set -a; . /etc/environment; set +a; exec tmux new-session -A -s $name"
EOF
chmod 755 /usr/local/bin/sandbox-terminal

# Mouse on: the wheel scrolls back through output (hold Shift to select text).
cat > /etc/tmux.conf <<'EOF'
set -g mouse on
set -g history-limit 50000
set -g default-terminal "tmux-256color"
# Size a terminal to the browser tab used last, not the smallest one attached
# (a hidden or old tab would otherwise shrink it for everyone).
set -g window-size latest
EOF

# --writable: input is allowed. --url-arg: ?arg=<n> picks the terminal.
# disableLeaveAlert: no "leave this page?" prompt when a tab closes.
cat > /etc/systemd/system/ttyd.service <<EOF
[Unit]
Description=ttyd: terminals in the browser
After=network.target

[Service]
ExecStart=/usr/bin/ttyd --port $TERMINAL_PORT --writable --url-arg -t disableLeaveAlert=true -t fontSize=14 /usr/local/bin/sandbox-terminal
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl enable ttyd.service

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
Environment=TIKTOKEN_CACHE_DIR=$desktop_home/.cache/tiktoken
ExecStart=$DEMO_DIR/run.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# --- Warm the download caches for common project packages --------------------

# Repos still install their own pinned versions; these just make the first
# install in a session faster. Run as the desktop user so the caches are theirs,
# from their home: uv looks for a uv.toml in the current folder, and they can't read /root.
# The uv cache only helps venvs on the same Python (the system 3.12).
# Each group is its own install, so one group's version limits don't hold back another.
(
    cd "$desktop_home"
    sudo -u "$desktop_user" -H npm cache add \
        react react-dom next vite @vitejs/plugin-react typescript tailwindcss \
        @tailwindcss/vite eslint express

    # Web backends
    sudo -u "$desktop_user" -H uv pip install --target /tmp/uv-warm-web \
        fastapi "uvicorn[standard]" pydantic sqlalchemy httpx flask django \
        alembic celery redis "psycopg[binary]" asyncpg

    # PyTorch, the biggest download. The default PyPI build is the CUDA one:
    # it runs on CPU now and on a GPU later, if a GPU is ever passed in.
    sudo -u "$desktop_user" -H uv pip install --target /tmp/uv-warm-torch \
        torch torchvision torchaudio

    # Models on top of PyTorch
    sudo -u "$desktop_user" -H uv pip install --target /tmp/uv-warm-ml \
        torch transformers accelerate safetensors datasets sentence-transformers \
        onnxruntime opencv-python-headless spacy nltk

    # Classic machine learning
    sudo -u "$desktop_user" -H uv pip install --target /tmp/uv-warm-classic \
        scikit-learn scikit-image xgboost lightgbm catboost statsmodels numba \
        sympy networkx

    # Data and charts
    sudo -u "$desktop_user" -H uv pip install --target /tmp/uv-warm-data \
        numpy pandas scipy matplotlib seaborn plotly kaleido bokeh altair dash \
        pyarrow duckdb polars openpyxl xlrd h5py tables pillow imageio \
        geopandas shapely folium pydeck jupyterlab notebook ipywidgets rich tqdm

    # LLM apps and their stores
    sudo -u "$desktop_user" -H uv pip install --target /tmp/uv-warm-llm \
        openai anthropic google-genai litellm tiktoken \
        langchain langchain-core langchain-openai langchain-community langgraph \
        llama-index-core mcp chromadb qdrant-client faiss-cpu sqlite-vec \
        opentelemetry-sdk opentelemetry-exporter-otlp huggingface_hub tokenizers \
        aiohttp orjson

    # Demo screens
    sudo -u "$desktop_user" -H uv pip install --target /tmp/uv-warm-ui \
        gradio streamlit

    # Tests and code tools
    sudo -u "$desktop_user" -H uv pip install --target /tmp/uv-warm-dev \
        pytest pytest-asyncio pytest-timeout pytest-cov black mypy pre-commit
)
rm -rf /tmp/uv-warm-*

# --- Models and data files libraries download on first use -------------------

# These land in the desktop user's home, not in the uv cache:
#   ~/.cache/huggingface   all-MiniLM-L6-v2 (sentence-transformers)
#   ~/.cache/chroma        Chroma's default embedding model
#   ~/.cache/tiktoken      OpenAI token encodings (TIKTOKEN_CACHE_DIR, see /etc/environment)
#   ~/nltk_data            punkt and stopwords
# The spaCy model wheel only goes in the uv cache.
spacy_model="https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
(
    cd "$desktop_home"
    sudo -u "$desktop_user" -H uv venv /tmp/warm-models --python /usr/bin/python3
    sudo -u "$desktop_user" -H uv pip install --python /tmp/warm-models/bin/python \
        sentence-transformers chromadb tiktoken nltk "en_core_web_sm @ $spacy_model"
    sudo -u "$desktop_user" -H env TIKTOKEN_CACHE_DIR="$desktop_home/.cache/tiktoken" \
        /tmp/warm-models/bin/python - <<'EOF'
from sentence_transformers import SentenceTransformer
SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

from chromadb.utils.embedding_functions import DefaultEmbeddingFunction
DefaultEmbeddingFunction()(["warm up"])

import tiktoken
tiktoken.get_encoding("cl100k_base")
tiktoken.get_encoding("o200k_base")

import nltk
nltk.download(["punkt", "punkt_tab", "stopwords"])
EOF
)
rm -rf /tmp/warm-models

# --- VS Code extensions ------------------------------------------------------

# Python support (it brings debugpy and Pylance with it), so a demo opened in
# VS Code can be run and debugged without installing anything first.
sudo -u "$desktop_user" -H code --install-extension ms-python.python

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
