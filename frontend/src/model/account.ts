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
