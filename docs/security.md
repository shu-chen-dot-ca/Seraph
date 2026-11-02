# Security

- **Agents have no host access.** They get no shell, no files and no web access on your computer. They only have Seraph's tools: reading GitHub, the lists, drafts, and their VM desktop. Everything they run, runs in a VM.
- **Tokens stay on your computer.** Your GitHub sign-in is kept in `data/github_account.json` (mode 600). It never reaches the browser, an agent or a VM. Seraph clones code on your computer and copies it into the VM.
- **What's sent is what you reviewed.** A pull request is rebuilt on your computer, from the reviewed diff and the project's files on GitHub. Diffs that contain a secret are refused.
- **Secret values stay hidden from agents.** Environment variables you set for the VMs are written into them. Agents see only their names, and any value that shows up in an agent's output is replaced with `[hidden]`.
- **Only you can reach the app.**
  - The backend listens on 127.0.0.1 only, and checks the Host and Origin of every request.
  - Through [remote access](../remote_access/README.md), every request needs a passkey.
- **Text from GitHub is never treated as instructions.** One-shot judgments, such as issue checks, review tone and AI policy, run with no tools at all.
- **VMs can't reach your computer or your network.** See [setup](setup.md#1-incus).
