/*
Your GitHub account: who you are signed in as, the one Approve sends as (GET /api/github_account; never the token).
Read again whenever a page signs in or out, which fires the window event "github-account".
*/

import { useEffect, useState } from "react";

import { api, type GithubAccountStatus } from "@/live";

export function useGithubAccount(): GithubAccountStatus | null {
  const [account, setAccount] = useState<GithubAccountStatus | null>(null);
  useEffect(() => {
    let stopped = false;
    function load() {
      api<GithubAccountStatus>("/api/github_account")
        .then((data) => {
          if (!stopped) {
            setAccount(data);
          }
        })
        .catch(() => {});
    }
    load();
    window.addEventListener("github-account", load);
    return () => {
      stopped = true;
      window.removeEventListener("github-account", load);
    };
  }, []);
  return account;
}

export type Sending = { draft: string | null; step: string };

// What a send to GitHub going on is doing (GET /api/github_account/sending): the draft being sent and its step, or
// draft null between sends. Asked every second while a page that shows it is open, so a send you started and then
// left (closing its dialog) still shows as sending when you come back.
export function useSending(): Sending {
  const [sending, setSending] = useState<Sending>({ draft: null, step: "" });
  useEffect(() => {
    let stopped = false;
    function load() {
      api<Sending>("/api/github_account/sending")
        .then((data) => {
          if (!stopped) {
            setSending((before) => (before.draft === data.draft && before.step === data.step ? before : data));
          }
        })
        .catch(() => {});
    }
    load();
    const timer = window.setInterval(load, 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
  return sending;
}
