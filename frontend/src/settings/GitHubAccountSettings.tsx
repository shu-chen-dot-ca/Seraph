import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, useLive, type GithubAccountStatus } from "@/live";

/*
Your GitHub account: the one Approve sends pull requests and comments as. Sign in with GitHub (once the app is
registered on GitHub: the form below walks you through it), or paste a classic token. It stays on this computer:
agents and searches never use it. Signing in or out fires the window event "github-account", so the header and other
pages read it again. Coming back from GitHub's sign-in page (backend/github_account_api.py's callback) lands here
with ?signed_in= or ?error=, said once. Your forks are where the app put your PRs' branches and pictures.
*/

export default function GitHubAccountSettings() {
  const inbox = useLive("inbox");
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);
  const [token, setToken] = useState("");
  const [useToken, setUseToken] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [savingApp, setSavingApp] = useState(false);
  const [accountError, setAccountError] = useState("");
  // Who the account is: at first, and again when it is connected or disconnected. The token itself never comes back.
  useEffect(() => {
    let stopped = false;
    function load() {
      api<GithubAccountStatus>("/api/github_account")
        .then((data) => {
          if (!stopped) {
            setAccount(data);
          }
        })
        .catch((err) => {
          if (!stopped) {
            setAccountError(`Could not load the GitHub account: ${err instanceof Error ? err.message : err}`);
          }
        });
    }
    load();
    window.addEventListener("github-account", load);
    return () => {
      stopped = true;
      window.removeEventListener("github-account", load);
    };
  }, []);

  // Back from GitHub's sign-in page (the callback in backend/github_account_api.py): what came of it, said once.
  useEffect(() => {
    const query = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const signedIn = query.get("signed_in");
    const error = query.get("error");
    if (signedIn === null && error === null) {
      return;
    }
    if (signedIn !== null) {
      toast.success(`Signed in as @${signedIn}. Approve now sends PRs and comments as this account.`);
      // Your PRs and issues from outside the app show up now too.
      api("/api/github/refresh", { method: "POST" }).catch(() => {});
    }
    if (error !== null) {
      setAccountError(error);
    }
    window.location.replace("#/settings");
  }, []);

  // The forks Approve sent PRs from, once each.
  const forks: string[] = [];
  for (const draft of inbox) {
    if (draft.sent !== null && draft.sent.fork !== undefined && !forks.includes(draft.sent.fork)) {
      forks.push(draft.sent.fork);
    }
  }

  async function connectAccount() {
    setConnecting(true);
    setAccountError("");
    try {
      const data = await api<GithubAccountStatus>("/api/github_account", { method: "PUT", body: { token: token } });
      setAccount(data);
      setToken("");
      setUseToken(false);
      window.dispatchEvent(new Event("github-account"));
      toast.success(`Signed in as @${data.login}. Approve now sends PRs and comments as this account.`);
      // Your PRs and issues from outside the app show up now too.
      api("/api/github/refresh", { method: "POST" }).catch(() => {});
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
    setConnecting(false);
  }

  async function signIn() {
    setSigningIn(true);
    setAccountError("");
    try {
      const data = await api<{ url: string }>("/api/github_account/sign_in", { method: "POST" });
      // GitHub's page, in this tab. It comes back to this page when you are done there.
      window.location.href = data.url;
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
      setSigningIn(false);
    }
  }

  async function saveApp() {
    setSavingApp(true);
    setAccountError("");
    try {
      setAccount(await api<GithubAccountStatus>("/api/github_account/app", { method: "PUT", body: { client_id: clientId, client_secret: clientSecret } }));
      setClientId("");
      setClientSecret("");
      setSettingUp(false);
      // The header's Sign in goes straight to GitHub now.
      window.dispatchEvent(new Event("github-account"));
      toast.success("Saved. Now sign in with GitHub.");
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
    setSavingApp(false);
  }

  async function disconnectAccount() {
    setAccountError("");
    try {
      setAccount(await api<GithubAccountStatus>("/api/github_account", { method: "DELETE" }));
      window.dispatchEvent(new Event("github-account"));
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <section>
        <div className="mb-2 font-medium">Your GitHub account</div>
        {accountError !== "" && <p className="mb-2 border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-destructive">{accountError}</p>}
        {account === null && accountError === "" && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading…
          </div>
        )}
        {account !== null && account.connected && (
          <div className="flex items-center gap-2">
            <span>
              Signed in as{" "}
              <a href={`https://github.com/${account.login}`} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                @{account.login}
              </a>
            </span>
            <span className="text-xs text-muted-foreground">{(account.scopes ?? []).join(", ")}</span>
            <div className="ml-auto">
              <Button variant="outline" size="sm" onClick={disconnectAccount}>
                Sign out
              </Button>
            </div>
          </div>
        )}
        {account !== null && !account.connected && account.can_sign_in && !settingUp && !useToken && (
          <div className="space-y-2">
            <Button onClick={signIn} disabled={signingIn}>
              {signingIn && <Loader2 className="animate-spin" />}
              {!signingIn && (
                // GitHub's mark (lucide has no brand icons).
                <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                </svg>
              )}
              Sign in with GitHub
            </Button>
            <div className="flex items-center gap-3 text-xs">
              <button type="button" className="text-primary hover:underline" onClick={() => setUseToken(true)}>
                Use a token instead
              </button>
              <button type="button" className="text-primary hover:underline" onClick={() => setSettingUp(true)}>
                Change app settings
              </button>
            </div>
          </div>
        )}
        {account !== null && !account.connected && (!account.can_sign_in || settingUp) && !useToken && (
          <div className="space-y-3">
            <p>To sign in with GitHub, register this app on GitHub once:</p>
            <ol className="list-decimal space-y-2 pl-5">
              <li>
                Open{" "}
                <a href="https://github.com/settings/applications/new" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  GitHub's form for a new OAuth app
                </a>
                , fill it in with these and click Register application:
                <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  <span className="text-muted-foreground">Application name</span>
                  <span className="font-mono select-all">Seraph</span>
                  <span className="text-muted-foreground">Homepage URL</span>
                  <span className="font-mono break-all select-all">{window.location.origin}</span>
                  <span className="text-muted-foreground">Authorization callback URL</span>
                  <span className="font-mono break-all select-all">{`${window.location.origin}/api/github_account/callback`}</span>
                </div>
              </li>
              <li>On the app's page, copy the Client ID. Then click Generate a new client secret and copy that too.</li>
              <li>Paste both here and Save.</li>
            </ol>
            <div className="flex items-center gap-1.5">
              <Input
                className="min-w-0 flex-1 font-mono text-xs"
                placeholder="Client ID"
                autoComplete="off"
                spellCheck={false}
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
              />
              <Input
                className="min-w-0 flex-1 font-mono text-xs"
                placeholder="Client secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && clientId.trim() !== "" && clientSecret.trim() !== "" && !savingApp) {
                    event.preventDefault();
                    saveApp();
                  }
                }}
              />
              <Button size="sm" onClick={saveApp} disabled={clientId.trim() === "" || clientSecret.trim() === "" || savingApp}>
                {savingApp && <Loader2 className="animate-spin" />}
                Save
              </Button>
              {settingUp && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSettingUp(false);
                    setClientId("");
                    setClientSecret("");
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setUseToken(true)}>
              Use a token instead
            </button>
          </div>
        )}
        {account !== null && !account.connected && useToken && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Input
                className="min-w-0 flex-1 font-mono text-xs"
                placeholder="ghp_…"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && token.trim() !== "" && !connecting) {
                    event.preventDefault();
                    connectAccount();
                  }
                }}
              />
              <Button size="sm" onClick={connectAccount} disabled={token.trim() === "" || connecting}>
                {connecting && <Loader2 className="animate-spin" />}
                Sign in
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setUseToken(false);
                  setToken("");
                }}
              >
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              For an organization that blocks apps it hasn't approved. Paste a classic token (
              <a
                href="https://github.com/settings/tokens/new?scopes=repo,workflow,read:org,gist,notifications,user&description=Seraph"
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                make one
              </a>
              ): fine-grained tokens can't open PRs on projects you don't own.
            </p>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Approve sends PRs and comments as this account, after you confirm, and so does Comment on a pull request or issue. It
          stays on this computer: agents and searches never use it.
        </p>
      </section>
      {forks.length > 0 && (
        <section>
          <div className="mb-2 font-medium">Your forks</div>
          <p className="mb-1 text-xs text-muted-foreground">Where the app put your PRs' branches and pictures.</p>
          {forks.map((fork) => (
            <div key={fork}>
              <a href={`https://github.com/${fork}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">
                {fork} <ExternalLink className="size-3" />
              </a>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
