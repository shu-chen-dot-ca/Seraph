# Remote access

Open Seraph from your phone, or any device, at your own address (for example `https://seraph.example.com`), signed in with a passkey (Face ID, Touch ID, Windows Hello or a security key). On this computer nothing changes: `http://localhost:5173` needs no sign-in.

```text
phone ──► seraph.example.com ──► forwarder (small server) ◄── this computer keeps an SSH line open ──► Caddy ──► Seraph
                                  passes encrypted bytes,                                              holds the
                                  holds no keys or data                                                certificate
```

- **The forwarder** is a small server (an AWS Lightsail one is fine) running nothing but SSH. This computer dials out to it and keeps the connection open, so it works on any network (home, hotspot, café) and doesn't depend on your router.
- **The encryption ends on this computer.** Caddy holds the certificate here, so the forwarder only sees encrypted traffic.
- **Every request through the address needs a sign-in.** Without one you only get the Sign in page. Devices are added on this computer only (Settings → Remote access → Add a device), and removing one signs it out at once.
- **What's here:** `Caddyfile`, `start_caddy.sh`, `start_tunnel.sh` (what runs), `set_up_server.sh`, `set_up_laptop.sh` (the one-time setup). Keys, certificates and the server's fingerprint go in `data/remote_access/`, never in git.

## Setup (once)

1. **A server.** The smallest Linux plan with Ubuntu is enough. Give it a static IP, and open ports 22, 80 and 443 in its firewall. Put the private key it was made with in `data/remote_access/admin_key` (`chmod 600`).
2. **`.env`.** Fill in `REMOTE_ACCESS_DOMAIN` (the address, e.g. `seraph.example.com`) and `REMOTE_ACCESS_SERVER` (the server's IP). The other `REMOTE_ACCESS_*` values can stay as they are.
3. **DNS.** At your domain's DNS, add an `A` record for the address pointing to the server's IP.
4. **The server's side.** Run `remote_access/set_up_server.sh`. It makes this computer's tunnel key and lets only that key pass the ports through.
5. **This computer's side.** Install Caddy (`sudo dnf install caddy` on Fedora), then run `remote_access/set_up_laptop.sh`. It starts `seraph-caddy` and `seraph-tunnel` as your own services, which restart by themselves. Within a minute Caddy has its certificate.
6. **Restart Seraph** (`./run.sh`) if it was running before `REMOTE_ACCESS_DOMAIN` was set: the backend and Vite read it when they start. Settings → Remote access then says **Reachable**.
7. **Add your phone.** On this computer, Settings → Remote access → **Add a device**. Scan the QR code with the phone's camera, and tap **Create passkey**. On an iPhone, Share → **Add to Home Screen** makes it open like an app; it signs in once more there, since it keeps its own cookies.

Logs: `journalctl --user -u seraph-caddy -u seraph-tunnel -f`.

## Notes

- **Sign in with GitHub** (GitHub tab → Account) only works on this computer: GitHub sends you back to localhost.
- **VM desktops and terminals** don't show through the address: they come straight from each VM, which only this computer can reach. The desktop pictures on the VMs page do show.
- **Lock the certificate to this computer (optional).** A DNS `CAA` record such as `0 issue "letsencrypt.org; accounturi=<Caddy's account URL>"` means only Caddy's Let's Encrypt account here can get a certificate for the address, so not even the server's provider could.
- **Moving Seraph to another computer:** copy `data/` (which has `remote_access/`) and `.env`. On a Mac or Windows, `start_caddy.sh` and `start_tunnel.sh` run as they are, kept running by launchd or as a Windows service instead of `set_up_laptop.sh`'s systemd services.
