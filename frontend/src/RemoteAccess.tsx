/*
Settings → Remote access: opening this app from your phone or any device at your own address, signed in with a
passkey (github_searcher/remote_access.py has how it works, remote_access/README.md the one-time setup).

Shows the address, or that remote access isn't set up, and whether the address reaches this computer right now
(Reachable / Not reachable: the backend asks it through the address, out to the forwarder and back). Then the
devices that may sign in, each with when it was added and last signed in. Remove (asks first) forgets that device's
passkey and signs it out at once. Opened through the address, the device you are on says This device and has Sign
out, which ends only its own sign in.

Add a device (only on this computer) makes a one-time link, shown as a QR code to scan with the phone's camera and
as the link itself (hidden from Sherpa). It works once, for 10 minutes: the phone opens the Add this device page,
makes its passkey with Face ID (or a fingerprint or PIN) and is signed in.

GET /api/remote_access each time Settings opens, and after every change.
*/

import { Loader2, Plus } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/live";
import { cn, timeAgo } from "@/lib/utils";

type Device = { id: string; name: string; added_at: string; last_used_at: string };

type Status = {
  domain: string;
  // null: not set up.
  reachable: boolean | null;
  on_this_computer: boolean;
  devices: Device[];
  this_device: string | null;
};

export default function RemoteAccess(props: { open: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  // Goes up after each change, so the status is asked again.
  const [changed, setChanged] = useState(0);
  const [link, setLink] = useState<{ link: string; minutes: number } | null>(null);
  const [making, setMaking] = useState(false);
  const [removing, setRemoving] = useState<Device | null>(null);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    let stopped = false;
    api<Status>("/api/remote_access")
      .then((data) => {
        if (!stopped) {
          setStatus(data);
        }
      })
      .catch((err) => {
        if (!stopped) {
          setError(`Could not load remote access: ${err instanceof Error ? err.message : err}`);
        }
      });
    return () => {
      stopped = true;
    };
  }, [props.open, changed]);

  // The link is only good for a while: it isn't shown again once Settings closes.
  useEffect(() => {
    if (!props.open) {
      setLink(null);
    }
  }, [props.open]);

  async function addDevice() {
    setMaking(true);
    setError("");
    try {
      setLink(await api<{ link: string; minutes: number }>("/api/remote_access/links", { method: "POST" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setMaking(false);
  }

  async function remove(device: Device) {
    try {
      await api(`/api/remote_access/devices/${device.id}`, { method: "DELETE" });
      toast.success(`${device.name} removed. It is signed out.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    setRemoving(null);
    setChanged(changed + 1);
  }

  async function signOut() {
    try {
      await api("/api/remote_access/sign_out", { method: "POST" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return;
    }
    window.location.href = "/api/remote_access/sign_in";
  }

  return (
    <section>
      <div className="mb-2 font-medium">Remote access</div>
      {error !== "" && <p className="mb-2 border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">{error}</p>}
      {status === null && error === "" && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading…
        </div>
      )}
      {status !== null && status.domain === "" && (
        <p className="text-muted-foreground">Not set up. remote_access/README.md has the steps.</p>
      )}
      {status !== null && status.domain !== "" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs">https://{status.domain}</span>
            <span className={cn("size-2 rounded-full", status.reachable ? "bg-ok" : "bg-warn")} />
            <span className="text-xs text-muted-foreground">
              {status.reachable ? "Reachable" : "Not reachable: the forwarder or Caddy isn't running"}
            </span>
          </div>

          {status.devices.length === 0 && <p className="text-muted-foreground">No devices yet.</p>}
          {status.devices.map((device) => (
            <div key={device.id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {device.name}
                  {device.id === status.this_device && <span className="ml-2 text-xs text-muted-foreground">This device</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  Added {timeAgo(device.added_at)} · Last signed in {timeAgo(device.last_used_at)}
                </div>
              </div>
              {device.id === status.this_device && (
                <Button variant="outline" size="sm" onClick={signOut}>
                  Sign out
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setRemoving(device)}>
                Remove
              </Button>
            </div>
          ))}

          {status.on_this_computer && link === null && (
            <Button variant="outline" size="sm" onClick={addDevice} disabled={making}>
              {making ? <Loader2 className="animate-spin" /> : <Plus />} Add a device
            </Button>
          )}
          {link !== null && (
            <div className="flex gap-3 rounded-lg border p-3">
              <div className="shrink-0 rounded-md bg-white p-2">
                <QRCodeSVG value={link.link} size={132} />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <p>Scan it with the phone's camera, then tap Create passkey. It works once, for {link.minutes} minutes.</p>
                {/* Sherpa never reads it: the link lets a device in. */}
                <Input readOnly data-secret className="font-mono text-xs" value={link.link} onFocus={(event) => event.target.select()} />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLink(null);
                    setChanged(changed + 1);
                  }}
                >
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It is signed out at once, and its passkey no longer opens Seraph. To use it again, add it again from this computer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing !== null) {
                  remove(removing);
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
