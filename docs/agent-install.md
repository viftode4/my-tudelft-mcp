# Agent installation runbook

## Goal and prerequisites

Install and configure the connector yourself when asked. Report installation,
host configuration, Brightspace authentication and optional providers separately.
Installation needs no university account. First sign-in still needs the student
to complete password/MFA in the browser; unattended authentication cannot be
promised. A graphical desktop is required for initial login.

Find an existing checkout and host configuration before creating duplicates.
Check `git --version`, `node --version`, `npm --version`. Node must be at least
22.16, the first 22.x release whose bundled SQLite includes the FTS5 extension local search needs; CI covers 22.16 and 24. If missing, use the machine's normal
package manager within the user's authorization and recheck. Preserve unrelated
runtimes/settings. Use the user's chosen directory, not another machine's path.

## Install

For a new checkout, run each command in order and check its exit status:

```sh
git clone https://github.com/viftode4/my-tudelft-mcp.git
cd my-tudelft-mcp
npm ci
npm run build
node scripts/smoke-install.mjs
node scripts/mcp-config.mjs
```

These commands work in PowerShell and POSIX shells. An installed Google Chrome or
Microsoft Edge is used for sign-in when present, so nothing is downloaded. Without
either, run `npx playwright install chromium` once (about 300 MB); on Linux,
missing browser libraries may require `npx playwright install --with-deps chromium`
and system package permissions. The smoke check below reports which it used. The startup smoke uses an empty temporary data directory,
checks headless Chromium and MCP discovery, and never opens interactive login.

## Configure the host

`mcp-config.mjs` prints JSON with this machine's Node executable and absolute
compiled entrypoint, including escaped Windows paths. Merge its server entry
into the selected host's existing `mcpServers` configuration, preserving other
settings. For another format, map `command` and `args` into its native settings.
Inspect local help/configuration first; never leave example placeholders.

For Codex, inspect `codex mcp add --help`, then register the generated executable
and arguments using `codex mcp add tudelft-brightspace -- <command> <args...>`.
Use actual argument values and shell-appropriate quoting. Reuse an existing
entry if it already points here. Codex TOML supports `startup_timeout_sec = 20`
and `tool_timeout_sec = 180`; use comparable tool timeouts in other hosts.

Run Node directly, not `npm start`: stdout carries MCP traffic only. Reload the
MCP connection after configuration or rebuilding. If the host cannot reload
itself, tell the student that one host restart is required.

## Authenticate once

Call `get_connection_status` first: it reports Brightspace, My TU Delft,
MyTimetable, recordings and optional email in one silent call, with the next step
for each. Use `check_auth` when you need Brightspace alone. Reuse a connected account. Use `refresh: true` for a
silent credential refresh, including when reads work but uploads fail. Routine
renewal must not open a visible window. If interactive sign-in is required,
explain that and wait for the student's explicit request to open a window.
Then call `begin_login` with `interactive: true` once and poll
`get_login_status`. Terminal alternative: `npm run login`, which connects
Brightspace, My TU Delft and MyTimetable in one run, then `npm run doctor`, which
reports every service.
Never ask for passwords, MFA, cookies or tokens in chat. Never navigate to copied
SSO callback URLs or repeatedly open browsers. Without a graphical desktop,
finish installation and report authentication pending. Retain private `.local/`.

## Test useful reads

Read `brightspace://usage`. Discover exact course IDs with `list_courses`, then
read content, announcements and assignments for a returned course. Follow
pagination and report partial coverage. Empty content is not a setup failure.
Keep private results out of public logs, fixtures and GitHub reports.

Optional providers are independent of core startup:

- **Official results:** check `check_mytu_auth`; if needed start
  `begin_mytu_login` once and poll `get_mytu_login_status`. Request explicit
  account confirmation if identity linking requires it. Never infer approval
  from a name. Verify `list_official_grades` and `get_official_progress`.
  For a degree average, read its `get_official_programme` curriculum; weight
  effective final numeric course grades by EC, exclude pass/fail credits and
  never double count retakes. Label a calculated average separately from GPA
  published by the university.
- **Timetable:** check `get_timetable_status`, then `get_timetable` with explicit
  offset timestamps. If unconfigured, follow the README's MyTimetable connection
  workflow. Keep the private subscription URL out of chat/logs.
- **Email:** install only if requested. Requires PowerShell 7.4+ (`pwsh`) and
  `pwsh -NoProfile -File scripts/install-mail.ps1`. Start `begin_mail_login` once
  and poll status. Show its official link/code if necessary. Use NetID@tudelft.nl.
  Error 53003 means an administrator policy blocks access: stop retries and
  report email unavailable. Core features remain independently usable. Do not
  create drafts as installation tests.
- **Recordings:** discovery does not prove playback or transcript access.
  Consult README limits before promising either.

## Update and report

Inspect Git status and preserve local changes. For a clean checkout, run
`git pull --ff-only`, repeat dependency installation/build/smoke and reload the
MCP connection. Preserve `.local/` and existing host settings.
For development/release changes also run `npm run check` and `npm test`.

Report installed commit, actual checks, host reload status and each provider's
connected/blocked state. Identify any remaining human action for authentication,
account confirmation or host controls. Never equate offline tests with live login.
