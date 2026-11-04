/*
Every page's address. The app lives in the URL hash, so reload, back and forward work, and every thing has exactly
one address. Links are plain <a href={href.…}>; App only reads the hash (parseRoute) and shows that page.

  #/inbox                     the Inbox (its Questions tab while any question waits, else Approvals)
  #/inbox/questions           #/inbox/approvals            one tab
  #/inbox/<draft id>          one question or approval
  #/notifications             what GitHub told you
  #/projects                  every project (the phone's Projects tab; on a computer they are in the left list)
  #/p/<owner>/<name>          a project's board            ?tab=agents|settings
  #/p/<owner>/<name>/<n>      one issue of it: open, being worked on, or done (a work item)
  #/jobs/<job id>             one job; a job on an issue opens that issue's page instead
  #/find                      find open-source projects
  #/team                      #/team/<agent id>
  #/machines                  ?tab=images|defaults|resource          #/machines/<vm>   ?tab=notes
  #/vm                        one desktop to use yourself, for the phone
  #/settings

Older addresses (from before the redesign, still written by a few pages and by bookmarks) are sent to their new
place by legacyAddress, so nothing links to a page that's gone.
*/

export type Route =
  | { page: "inbox"; tab: "questions" | "approvals" | null }
  | { page: "inbox-item"; id: string }
  | { page: "notifications" }
  | { page: "projects" }
  | { page: "project"; repo: string; tab: string | null }
  | { page: "work"; repo: string; number: number }
  | { page: "job"; id: string }
  | { page: "find" }
  | { page: "team" }
  | { page: "agent"; id: string }
  | { page: "machines"; tab: string | null }
  | { page: "machine"; name: string; tab: string | null }
  | { page: "phone-vm" }
  | { page: "settings" };

export const href = {
  inbox: (tab?: "questions" | "approvals") => (tab ? `#/inbox/${tab}` : "#/inbox"),
  inboxItem: (draftId: string) => `#/inbox/${draftId}`,
  notifications: () => "#/notifications",
  projects: () => "#/projects",
  project: (repo: string, tab?: string) => `#/p/${repo}${tab ? `?tab=${tab}` : ""}`,
  work: (repo: string, number: number) => `#/p/${repo}/${number}`,
  job: (jobId: string) => `#/jobs/${jobId}`,
  find: () => "#/find",
  team: () => "#/team",
  agent: (agentId: string) => `#/team/${agentId}`,
  machines: (tab?: string) => `#/machines${tab ? `?tab=${tab}` : ""}`,
  machine: (name: string) => `#/machines/${encodeURIComponent(name)}`,
  settings: () => "#/settings",
};

// "#/p/owner/name/12?tab=x" → path ["p", "owner", "name", "12"], query {tab: "x"}.
function split(hash: string): { path: string[]; query: URLSearchParams } {
  const [pathPart, queryPart] = hash.replace(/^#\/?/, "").split("?");
  const path = pathPart.split("/").filter((part) => part !== "").map((part) => decodeURIComponent(part));
  return { path: path, query: new URLSearchParams(queryPart ?? "") };
}

export function parseRoute(hash: string): Route {
  const { path, query } = split(hash);
  const [first, second, third, fourth] = path;
  if (first === "inbox" && second === undefined) {
    return { page: "inbox", tab: null };
  }
  if (first === "inbox" && (second === "questions" || second === "approvals")) {
    return { page: "inbox", tab: second };
  }
  if (first === "inbox") {
    return { page: "inbox-item", id: second };
  }
  if (first === "notifications") {
    return { page: "notifications" };
  }
  if (first === "projects") {
    return { page: "projects" };
  }
  if (first === "p" && second !== undefined && third !== undefined && fourth !== undefined && /^\d+$/.test(fourth)) {
    return { page: "work", repo: `${second}/${third}`, number: Number(fourth) };
  }
  if (first === "p" && second !== undefined && third !== undefined) {
    return { page: "project", repo: `${second}/${third}`, tab: query.get("tab") };
  }
  if (first === "jobs" && second !== undefined) {
    return { page: "job", id: second };
  }
  if (first === "find") {
    return { page: "find" };
  }
  if (first === "team" && second !== undefined) {
    return { page: "agent", id: second };
  }
  if (first === "team") {
    return { page: "team" };
  }
  if (first === "machines" && second !== undefined) {
    return { page: "machine", name: second, tab: query.get("tab") };
  }
  if (first === "machines") {
    return { page: "machines", tab: query.get("tab") };
  }
  if (first === "vm") {
    return { page: "phone-vm" };
  }
  if (first === "settings") {
    return { page: "settings" };
  }
  return { page: "inbox", tab: null };
}

// "owner/name#12" → the issue's page; anything else → null.
function workAddress(id: string | null): string | null {
  const match = (id ?? "").match(/^([^/#]+\/[^/#]+)#(\d+)$/);
  return match === null ? null : href.work(match[1], Number(match[2]));
}

// An address from before the redesign → where that page is now, or null when the address is a current one.
export function legacyAddress(hash: string): string | null {
  const { path, query } = split(hash);
  const [first, second, third] = path;
  const repo = query.get("repo");
  const open = workAddress(query.get("open"));
  const rest = query.toString();
  if (first === "agents") {
    return second !== undefined ? href.agent(second) : href.team();
  }
  if (first === "vms" && second !== undefined) {
    return `${href.machine(second)}${rest !== "" ? `?${rest}` : ""}`;
  }
  if (first === "vms") {
    return href.machines(query.get("tab") ?? undefined);
  }
  if (first === "resource") {
    return href.machines("resource");
  }
  if (first === "explore") {
    return href.find();
  }
  if (first === "jobs" && second === undefined) {
    return href.team();
  }
  if (first === "github" && second === "account") {
    return `${href.settings()}${rest !== "" ? `?${rest}` : ""}`;
  }
  if (first === "github" && second === "notifications") {
    return href.notifications();
  }
  if (first === "github" && second === "overview") {
    return href.inbox();
  }
  if (first === "github" && second === "repo" && repo !== null) {
    return open ?? href.project(repo);
  }
  if (first === "issues" || first === "github" || first === "workflow" || first === "home" || first === "pulls") {
    if (open !== null) {
      return open;
    }
    // The Workflow tab's open= is a number in that repo.
    if (first === "workflow" && repo !== null && /^\d+$/.test(query.get("open") ?? "")) {
      return href.work(repo, Number(query.get("open")));
    }
    return repo !== null ? href.project(repo) : href.projects();
  }
  if (first === "repos" || first === "tracked" || first === "papers") {
    return href.projects();
  }
  if (first === "inbox" && second !== undefined && third !== undefined) {
    return href.inboxItem(second);
  }
  return null;
}
