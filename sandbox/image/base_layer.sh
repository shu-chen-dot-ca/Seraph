#!/usr/bin/env bash
# The base layer of every image: the desktop, Firefox, and everything the app needs in a VM.
# sandbox/image_build.py runs it first, as root, in a fresh VM from the official image, before anything in the
# image's image.yaml. image.yaml never has any of this, so neither the user nor the image's agent can break it.
#
# Only official sources, and nothing big: the system's own packages, and Mozilla's repository for Firefox on
# Ubuntu and Debian (Ubuntu's own firefox is a snap). A few minutes, most of it the desktop's packages.
#
# In its environment (from image_build.py):
#   SANDBOX_FAMILY            apt (Ubuntu, Debian) or dnf (Fedora)
#   SANDBOX_DESKTOP           gnome, kde or none (terminal only)
#   SANDBOX_NO_DESKTOP_FILE   made in a terminal-only image, so the app shows its terminal instead of a desktop
#   SANDBOX_VM_*              the app's ports and paths
#
# Ports inside the VM:
#   SANDBOX_VM_NOVNC_PORT     noVNC: the desktop in the browser (http://<vm>:<port>/vnc.html)
#   SANDBOX_VM_VNC_PORT       VNC, only on localhost (noVNC talks to it)
#   SANDBOX_VM_TERMINAL_PORT  ttyd: terminals in the browser (http://<vm>:<port>/?arg=<n>)
#
# The app itself masks fwupd and sets the kernel argument clearcpuid=user_shstk (VM.guard_shadow_stack), and
# cleans up before publishing (image_build.CLEANUP_SCRIPT).

set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

FAMILY=$SANDBOX_FAMILY
DESKTOP=$SANDBOX_DESKTOP
FALLBACK_USER=$SANDBOX_VM_FALLBACK_USER
PY_VENV=$SANDBOX_VM_PY_VENV
RUST_DIR=$SANDBOX_VM_RUST_DIR
PLAYWRIGHT_DIR=$SANDBOX_VM_PLAYWRIGHT_DIR
DEMO_DIR=$SANDBOX_VM_DEMO_DIR
NOVNC_PORT=$SANDBOX_VM_NOVNC_PORT
VNC_PORT=$SANDBOX_VM_VNC_PORT
TERMINAL_PORT=$SANDBOX_VM_TERMINAL_PORT

# A desktop image updates itself on first boot; wait for apt's lock instead of failing.
APT="apt-get -y -o DPkg::Lock::Timeout=900"

if command -v cloud-init > /dev/null; then
    cloud-init status --wait || true
fi

# --- Packages ---------------------------------------------------------------------

if [[ $FAMILY == apt ]]; then
    $APT update
    $APT upgrade
    $APT install sudo curl ca-certificates gnupg git tmux python3 iptables iproute2 xz-utils ttyd cloud-guest-utils
fi
if [[ $FAMILY == apt && $DESKTOP != none ]]; then
    $APT install xserver-xorg x11-xserver-utils xdotool scrot x11vnc novnc python3-websockify
fi
if [[ $FAMILY == dnf ]]; then
    dnf -y upgrade
    dnf -y install sudo curl ca-certificates git tmux python3 iptables-nft iproute xz ttyd cloud-utils-growpart
fi
if [[ $FAMILY == dnf && $DESKTOP != none ]]; then
    dnf -y install xorg-x11-server-Xorg xset xdotool scrot x11vnc novnc python3-websockify
fi

# --- The desktop --------------------------------------------------------------------

# GNOME: Ubuntu's desktop image has it already; Debian gets GNOME's core.
if [[ $DESKTOP == gnome && ! -d /etc/gdm3 ]]; then
    $APT install gnome-core gdm3
fi
if [[ $DESKTOP == kde && $FAMILY == apt ]]; then
    $APT install kde-plasma-desktop sddm
fi
# Newer Plasma has its X11 session in a package of its own.
if [[ $DESKTOP == kde && $FAMILY == apt ]] && ! ls /usr/share/xsessions/plasma*.desktop > /dev/null 2>&1; then
    $APT install plasma-session-x11
fi
if [[ $DESKTOP == kde && $FAMILY == dnf ]]; then
    dnf -y install plasma-desktop plasma-workspace-x11 sddm konsole dolphin
fi

# The agents drive the desktop through X11 (xdotool, scrot), so it needs an X11 session, never Wayland.
if [[ $DESKTOP != none ]] && ! ls /usr/share/xsessions/*.desktop > /dev/null 2>&1; then
    echo "This system's $DESKTOP has no X11 session, which the agents need (xdotool, scrot). Pick another desktop or system."
    exit 1
fi

# Firefox: Mozilla's own package (Ubuntu's firefox is only a snap, Debian's is the ESR), Fedora's own.
if [[ $FAMILY == apt && $DESKTOP != none ]]; then
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc
    echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" > /etc/apt/sources.list.d/mozilla.list
    printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' > /etc/apt/preferences.d/mozilla
    $APT update
fi
# A desktop image installs its snaps on first boot: wait for that before looking.
if [[ $FAMILY == apt && $DESKTOP != none ]] && command -v snap > /dev/null; then
    timeout 600 snap wait system seed.loaded || true
fi
if [[ $FAMILY == apt && $DESKTOP != none ]] && command -v snap > /dev/null && snap list firefox > /dev/null 2>&1; then
    snap remove --purge firefox
fi
# Ubuntu's own firefox package (a stub that installs the snap) has a higher version than Mozilla's, so apt
# counts Mozilla's as a downgrade.
if [[ $FAMILY == apt && $DESKTOP != none ]]; then
    $APT install --allow-downgrades firefox
fi
if [[ $FAMILY == dnf && $DESKTOP != none ]]; then
    dnf -y install firefox
fi

# --- The desktop user -----------------------------------------------------------------

# uid 1000 if the image has one, otherwise we make FALLBACK_USER. The app runs everything as this user.
desktop_user=$(id -nu 1000 2>/dev/null || true)
if [[ -z "$desktop_user" ]]; then
    useradd --create-home --uid 1000 --shell /bin/bash "$FALLBACK_USER"
    desktop_user=$FALLBACK_USER
fi
desktop_home=$(getent passwd "$desktop_user" | cut -d: -f6)
echo "$desktop_user ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-desktop-user
chmod 440 /etc/sudoers.d/90-desktop-user

# Read at login (the desktop session, the browser terminals, the agents' commands). Folders that aren't
# there yet (Python, Rust, Go) do no harm, and image.yaml's steps don't have to add them.
cat > /etc/environment <<EOF
PATH="$PY_VENV/bin:/usr/local/go/bin:$RUST_DIR/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
RUSTUP_HOME="$RUST_DIR"
PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_DIR/browsers"
EOF

# --- Quiet: no welcome wizard, no update or crash popups, no package manager in the background ---

if [[ $FAMILY == apt ]]; then
    # Purging these also removes Ubuntu's desktop meta-package, which would let a later `apt autoremove`
    # strip out the desktop. So first mark everything installed as wanted on its own.
    apt-mark showauto | xargs -r apt-mark manual > /dev/null
    systemctl mask apt-daily.timer apt-daily-upgrade.timer
fi
for package in gnome-initial-setup update-notifier apport whoopsie unattended-upgrades plasma-welcome; do
    if [[ $FAMILY == apt ]] && dpkg -s "$package" > /dev/null 2>&1; then
        $APT purge "$package"
    fi
done
for package in gnome-initial-setup plasma-welcome plasma-discover-notifier; do
    if [[ $FAMILY == dnf ]] && rpm -q "$package" > /dev/null 2>&1; then
        dnf -y remove "$package"
    fi
done
if [[ $FAMILY == dnf ]]; then
    systemctl mask dnf-makecache.timer
fi
systemctl mask packagekit.service

# The app reaches noVNC and ttyd from this machine.
if command -v firewall-cmd > /dev/null; then
    systemctl disable --now firewalld
fi

# A desktop's network is run by NetworkManager. systemd-networkd manages no link then,
# so its wait-online job only holds up every boot for its 2 minute timeout.
if command -v NetworkManager > /dev/null; then
    systemctl mask systemd-networkd-wait-online.service
fi

# --- The desktop: X11, logs in by itself, never locks or blanks ----------------------

if [[ $DESKTOP == gnome ]]; then
    # Ubuntu reads custom.conf, Debian daemon.conf.
    for file in /etc/gdm3/custom.conf /etc/gdm3/daemon.conf; do
        printf '[daemon]\nWaylandEnable=false\nAutomaticLoginEnable=true\nAutomaticLogin=%s\n' "$desktop_user" > "$file"
    done
    mkdir -p /etc/dconf/profile /etc/dconf/db/local.d
    printf 'user-db:user\nsystem-db:local\n' > /etc/dconf/profile/user
    cat > /etc/dconf/db/local.d/00-sandbox <<'EOF'
[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/screensaver]
lock-enabled=false

[org/gnome/desktop/lockdown]
disable-lock-screen=true

[org/gnome/shell]
favorite-apps=['firefox.desktop', 'org.gnome.Nautilus.desktop', 'org.gnome.Terminal.desktop', 'org.gnome.Console.desktop']
EOF
    dconf update
    # In case anything still looks for it: first-login setup is done.
    mkdir -p "$desktop_home/.config"
    echo yes > "$desktop_home/.config/gnome-initial-setup-done"
    chown -R "$desktop_user:" "$desktop_home/.config"
fi

if [[ $DESKTOP == kde ]]; then
    # plasmax11 on Plasma 6, plasma (its X11 session) on Plasma 5.
    session=$(basename "$(ls /usr/share/xsessions/plasma*.desktop | head -1)" .desktop)
    mkdir -p /etc/sddm.conf.d
    printf '[General]\nDisplayServer=x11\n\n[Autologin]\nUser=%s\nSession=%s\n' "$desktop_user" "$session" > /etc/sddm.conf.d/sandbox.conf
    printf '[Daemon]\nAutolock=false\nLockOnResume=false\nTimeout=0\n' > /etc/xdg/kscreenlockerrc
    systemctl enable --force sddm
fi

if [[ $DESKTOP != none ]]; then
    systemctl set-default graphical.target
    # No screen blanking, whatever the desktop's own settings say.
    printf '[Desktop Entry]\nType=Application\nName=No screen blanking\nExec=sh -c "xset s off; xset s noblank; xset -dpms"\nNoDisplay=true\n' > /etc/xdg/autostart/sandbox-no-blank.desktop
fi

# --- The desktop in the browser: x11vnc + noVNC ---------------------------------------

if [[ $DESKTOP != none ]]; then
    # x11vnc starts inside the desktop session, so it gets the right display. Only on localhost; noVNC is the way in.
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
fi

if [[ $DESKTOP == none ]]; then
    touch "$SANDBOX_NO_DESKTOP_FILE"
fi

# --- Terminals in the browser: ttyd + tmux -----------------------------------------------

# Each terminal tab opens http://<vm>:<port>/?arg=<n> and gets tmux session <n> as the desktop user.
# Closing the browser tab leaves the session running; the backend kills it when the tab is closed in the app.
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
# Size a terminal to the browser tab used last, not the smallest one attached.
set -g window-size latest
EOF

# Input is allowed (ttyd before 1.7 always allows it and has no --writable). --url-arg: ?arg=<n> picks the terminal.
# The help is read first: in a pipe, ttyd's own exit code (or grep -q closing it early) would decide under pipefail.
ttyd_help=$(ttyd --help 2>&1 || true)
writable=""
if [[ $ttyd_help == *--writable* ]]; then
    writable="--writable"
fi
cat > /etc/systemd/system/ttyd.service <<EOF
[Unit]
Description=ttyd: terminals in the browser
After=network.target

[Service]
ExecStart=/usr/bin/ttyd --port $TERMINAL_PORT $writable --url-arg -t disableLeaveAlert=true -t fontSize=14 /usr/local/bin/sandbox-terminal
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl enable ttyd.service

# --- The demo service -----------------------------------------------------------------------

# The main agents write the start command to DEMO_DIR/run.sh, then `sudo systemctl enable --now demo`.
# It survives the agent's shell ending and VM restarts. Logs: `journalctl -u demo`.
mkdir -p "$DEMO_DIR"
printf '#!/usr/bin/env bash\necho "No demo yet: the agent writes the start command here."\nexit 1\n' > "$DEMO_DIR/run.sh"
chmod 755 "$DEMO_DIR/run.sh"
chown -R "$desktop_user:" "$DEMO_DIR"
cat > /etc/systemd/system/demo.service <<EOF
[Unit]
Description=The repo's demo, started by the agent
After=network-online.target docker.service

[Service]
User=$desktop_user
WorkingDirectory=$desktop_home
EnvironmentFile=/etc/environment
ExecStart=$DEMO_DIR/run.sh
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# --- The root filesystem fills the disk ----------------------------------------------------

# VMs get bigger disks than the image: grow the root partition and its filesystem at every boot.
cat > /usr/local/bin/sandbox-grow-root <<'EOF'
#!/usr/bin/env bash
source=$(findmnt -no SOURCE / | sed 's/\[.*//')
disk=$(lsblk -no PKNAME "$source" | head -1)
part=$(cat "/sys/class/block/$(basename "$source")/partition")
# growpart exits 1 when there is nothing to grow.
growpart "/dev/$disk" "$part" || true
case "$(findmnt -no FSTYPE /)" in
    ext4) resize2fs "$source" ;;
    xfs) xfs_growfs / ;;
    btrfs) btrfs filesystem resize max / ;;
esac
EOF
chmod 755 /usr/local/bin/sandbox-grow-root
cat > /etc/systemd/system/sandbox-grow-root.service <<'EOF'
[Unit]
Description=Grow the root filesystem to fill the disk

[Service]
Type=oneshot
ExecStart=/usr/local/bin/sandbox-grow-root

[Install]
WantedBy=multi-user.target
EOF
systemctl enable sandbox-grow-root.service
