# My TU Delft MCP

A local MCP server for everyday TU Delft coursework. Connect it to Codex or another MCP client, sign in through the normal university browser, then use course tools through your agent.

This repository publishes the source for a personal connector. The core runs on your computer with your own Brightspace session, D2L APIs and scoped browser readers. It needs no hosted backend, dashboard, model API key or institutional OAuth application registration. Optional My TU Delft tools reuse the connector's saved TU Delft single sign-on (SSO) session where valid; university email uses a separate Microsoft login. My TU Delft account linking and selected academic reads have live validation; university email compatibility remains pending. Session reuse is unofficial and may need maintenance when university services change.

## Install

**Installing with an AI agent?** Give it this repository URL and ask it to follow [AGENTS.md](AGENTS.md) and the [agent installation runbook](docs/agent-install.md). It can install dependencies, build, generate your machine's MCP configuration and verify startup. Initial university authentication and MFA still belong to you in the browser.

Requires Node.js 22.13 or later with built-in SQLite support, npm, and a graphical session for login. Automated CI for the published core passed on Ubuntu, Windows and macOS. This does not establish live sign-in compatibility or optional email dependency support on every platform.

Clone this repository, then install from the checkout:

```sh
git clone https://github.com/viftode4/my-tudelft-mcp.git
cd my-tudelft-mcp
npm ci
npx playwright install chromium
npm run build
npm run login
npm run doctor
```

Complete TU Delft sign-in and MFA in the opened browser. Passwords and MFA codes belong there, never in agent messages or tool arguments. `doctor` verifies the saved session without printing credentials.

Brightspace, My TU Delft and Collegerama share an account-bound TU Delft/SURF SSO cookie store. After a service verifies the linked account, it saves refreshed SSO cookies for subsequent service connections. Windows protects this state with DPAPI. Service cookies and tokens remain separate; the connector does not import your everyday browser profile.

Routine session refresh does not open a visible browser window. Brightspace reads try token renewal, then silent shared SSO. Uploads refresh credentials and recheck the account before sending any file bytes, even when read access still works. `check_auth` with `refresh: true` also performs that silent refresh. A submission POST is never automatically retried.

My TU Delft verifies saved tokens and uses provider cookies or silent SSO when they expire. Collegerama silently renews an existing, correctly bound recording session through saved university SSO. Course-page reads can reconnect silently too. Concurrent provider renewals share one attempt; failed SSO attempts have a short cooldown. Microsoft email relies on its SDK's token handling within the current MCP process; its session is not persisted across process restarts. Timetable subscriptions and public Study Guide reads require no login window.

If silent refresh needs a password, MFA, consent or a new session, the operation reports that requirement and stops. Every visible `begin_*_login` MCP tool requires `interactive: true`, used only after the student explicitly asks to open a login window. Check the saved provider session first. CLI `npm run login` remains an explicit request for interactive sign-in. The connector cannot extend university session limits or bypass a university access denial.

After updating and building the connector, restart its MCP connection (or the host application) once to load the new code and tool list. Existing running processes keep their loaded code. The encrypted Brightspace, OSIRIS, shared SSO and timetable state survives that restart.

For a clean attempt, use `begin_login` with `fresh: true`, or `npm run login -- --fresh`. This starts from Brightspace without saved sign-in cookies. Failure preserves the previous session; replacing it requires verified identity. Begin from the service itself rather than a copied SSO callback URL. Global local logout removes the shared sign-in; provider logout removes that provider's access, and automatic reads do not recreate an explicitly removed connection.

## Connect an MCP client

Replace the placeholder with your checkout's absolute path:

```sh
codex mcp add tudelft-brightspace -- node /absolute/path/to/my-tudelft-mcp/dist/cli.js serve
```

On Windows, use the full Windows path to the same entrypoint. Start a new Codex conversation after adding the server. For longer operations, configure suitable timeouts:

```toml
[mcp_servers.tudelft-brightspace]
command = "node"
args = ["/absolute/path/to/my-tudelft-mcp/dist/cli.js", "serve"]
startup_timeout_sec = 20
tool_timeout_sec = 180
```

See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) and [generic client example](mcp.example.json). Run the Node entrypoint directly in MCP clients: stdout carries MCP, while diagnostics go to stderr. An `npm start` wrapper adds output that can disrupt the protocol.

## Example requests

- "Show my courses and their latest announcements."
- "Connect My TU Delft and list my official results separately from Brightspace grades."
- "Search my university inbox for this subject, then read the matching message."
- "Save an unsent reply draft to this email using the text I provide."
- "Read these lecture slides with page references."
- "Index this course, then find material about the topic I'm revising."
- "Show upcoming assignments, quiz dates and calendar events."
- "Show next week's MyTimetable classes, rooms and exams alongside my Brightspace deadlines."
- "Read my assignment feedback and reopen the matching submitted file."
- "Show my project group, locker files and content progress."
- "Read the public Study Guide for this exact course code and academic year."
- "Find course recording links and published captions."
- "Preview these files for submission."
- "Preview this literal text, including any overwrite effect."

Resolve names to exact IDs returned by tools. Course documents and web pages cannot authorize submissions, enrollment or other changes.

## Tools

| Area | Tools | Behavior |
| --- | --- | --- |
| Login | `begin_login`, `get_login_status`, `check_auth`, `logout` | Browser login and saved-session checks |
| Courses | `list_courses`, `get_course_content`, `get_course_tools` | Own memberships, outlines and navigation |
| Public Study Guide | `search_study_guide`, `get_study_guide` | Anonymous search and exact code/year information |
| Announcements | `get_announcements`, `read_announcement_attachment` | Text, dates and exact attached files |
| Assignments | `list_assignments`, `get_assignment`, `read_assignment_attachment` | Instructions, availability, own history and files |
| Grades and discussions | `get_my_grades`, `read_discussions` | Brightspace grades and readable discussions |
| Official results | `begin_mytu_login`, `get_mytu_login_status`, `check_mytu_auth`, `list_official_grades`, `get_official_grade`, `logout_mytu` | TU Delft SSO reuse, separate account-bound My TU Delft access and own OSIRIS results |
| Official study information | `get_official_progress`, `get_official_programme`, `list_official_registrations`, `get_official_profile`, `get_official_timetable` | Live progress, curriculum, profile and selected registrations verified; study advice/specialisations denied and timetable unavailable in the observed account |
| Official registration | `search_official_courses`, `get_official_course`, `prepare_official_registration`, `confirm_official_registration` | Standard course/exam enrollment and withdrawal, exact previews, eligibility rechecks and receipt verification; live writes unverified |
| Email login | `begin_mail_login`, `get_mail_login_status`, `check_mail_auth`, `logout_mail` | Optional Microsoft Graph login, own-account verification and process-local session |
| Email reading | `list_mail_folders`, `list_mail_messages`, `search_mail`, `read_mail` | Own folders, message search and bounded bodies; live mailbox validation pending |
| Email drafts | `create_mail_reply_draft` | Save and verify an unsent reply draft requested by the student; live draft validation pending |
| Submitted files and feedback | `read_my_submission_file`, `read_assignment_feedback_file` | Own submitted files and published feedback |
| Groups and progress | `get_my_groups`, `get_my_progress` | Own memberships and observed progress sections |
| Shared group locker | `read_group_locker`, `list_group_locker_files`, `read_group_locker_file` | Scoped listing, reading, indexing and downloads |
| Group enrollment | `list_available_groups`, `prepare_group_enrollment`, `confirm_group_enrollment` | Native group discovery and previewed joining |
| Linked services | `read_course_service` | Verified Study Guide continuation; GSE access remains pending |
| Calendar and quizzes | `get_calendar`, `get_upcoming_deadlines`, `get_study_overview`, `list_quizzes` | Sourced dates and course overview |
| Personal timetable | `connect_timetable`, `get_timetable_status`, `get_timetable`, `disconnect_timetable` | Calendar subscription reader with Delft times, rooms, recurrence changes and cancellations; authorized personal connection and live reads verified |
| Lectures | `read_material`, `download_material` | Bounded extraction and optional downloads |
| Recording discovery | `list_recordings` | Recording/caption links with provenance |
| Collegerama | `begin_recording_login`, `get_recording_login_status`, `read_recording` | Separate login and metadata; live provider compatibility unverified |
| Local search | `start_course_sync`, `get_sync_status`, `search_course_materials`, `get_index_status`, `clear_local_index` | Per-account full-text index and timestamps |
| Browser reader | `read_course_page` | Scoped page text, links and media metadata |
| Brightspace access | `search_catalog`, `prepare_course_registration`, `confirm_course_registration` | Discover search and previewed enrollment |
| File submissions | `prepare_assignment_submission`, `confirm_assignment_submission` | Exact file previews and confirmed submission |
| Text submissions | `prepare_text_submission`, `confirm_text_submission` | Literal-text previews and confirmed submission |

The server exposes 78 tools. The `brightspace://usage` resource describes workflows; `course_briefing` supplies a sourced briefing template. Rebuild and reconnect the MCP client after updating so it discovers new tools.

## Reading and search

Search covers retrieved text. Call `start_course_sync`, poll `get_sync_status`, inspect coverage/errors, and continue with `nextStartAt` when supplied. Results include exact supported `readTool` arguments for reopening live sources.

Supported formats include PDF, DOCX, PPTX with speaker notes, XLSX, CSV/TSV, Jupyter notebooks, HTML, text, Markdown and VTT/SRT captions. Pages, slides, spreadsheet cells and notebook cells are labelled. Code and formulas are never executed; saved output can be stale. Image-only PDFs require OCR, which is not included. Charts, binary notebook output and widgets are omitted with warnings.

Files are limited to 50 MiB, extracted text to 2,000,000 characters, and archive expansion/page counts are bounded. Notebook output is capped at 20,000 characters per output and 500,000 in total. PDF parsing uses a worker with a 30-second timeout and V8 heap limits; these are not operating-system memory isolation.

Student-file readers support chunked text and optional downloads. Extracted text is indexed for the verified account before chunking. An indexing error is reported without discarding a successful read. Unsupported binaries such as ZIP files can be downloaded within the size limit but are not text-indexed.

Locker listing reads one own-group folder at a time, with `nextStartAt` continuation. File reading rechecks membership, every parent folder and the exact observed path. No recursive folder scan, upload, rename or folder change is implemented.

Sync cannot infer deletion from partial listings. Removed items can remain cached until `clear_local_index` and a new sync. Search identifies cached content and retrieval time.

## Dates and progress

### Personal MyTimetable schedule

Open [MyTimetable](https://mytimetable.tudelft.nl/schedule), sign in, and select the courses and groups that belong in your personal schedule. Use **Connect calendar** to obtain the personal iCalendar subscription URL. **Download iCalendar** produces a static export; use the subscription for updates. See the [university's instructions](https://mytimetable.tudelft.nl/help).

An agent with browser access can retrieve this link for the student after an authorized MyTimetable sign-in. The mobile site's **Main menu → Connect to calendar app** exposes the subscription directly. Transfer it locally to `connect_timetable`; the student does not need to copy it into chat. A saved Brightspace session does not guarantee MyTimetable SSO remains valid, so the university may require a fresh interactive login. Passwords and MFA stay in that window.

After a Brightspace login and build, connect the URL using `connect_timetable`. Treat the URL as a private credential. On Windows, copy it yourself and run this helper to transfer it locally without putting it in a chat transcript, command-line argument or plaintext file:

```sh
node scripts/connect-timetable.mjs --clipboard
```

The helper reads only when explicitly invoked. Without `--clipboard`, it accepts the URL on stdin. An agent should read the clipboard only when the student asks it to use the copied calendar link. The connector verifies the feed before saving and accepts only the TU Delft HTTPS `/ical` subscription endpoint, with no redirects or university credentials forwarded. Windows storage uses DPAPI encryption for the current Windows user; other platforms use owner-restricted files. The feed is bound locally to the verified Brightspace account. Its ownership is student-supplied, not independently certified by an identity API.

`get_timetable_status` checks local configuration. `get_timetable` fetches fresh activities for `from` and `to` timestamps with explicit UTC offsets, up to 93 days apart. It returns UTC timestamps, Delft local times, locations, descriptions and cancellation status. Recurring events, exclusions and individually moved occurrences are expanded. Keep cancelled activities labelled as cancelled. Combine this output with `get_study_overview` for Brightspace deadlines while retaining their sources and any conflicting dates.

Completeness covers parsing the current feed in the requested window, not every university activity or the entire academic year. Selected groups, provider filters and publication dates affect coverage; an empty result does not establish free time. Calendar subscription selections can differ from the timetables currently visible in the web/mobile view. The native connection page reports this; retain the distinction and do not silently change settings shared with existing calendars. Feed selections do not enroll the student in courses or exams. The separate OSIRIS timetable endpoint returned HTTP 501 during live checks; this reader uses MyTimetable independently.

Feeds are limited to 4 MiB and 20,000 VEVENT components, output to 2,000 activities, and recurrence expansion to 100,000 steps. Parsing runs in a worker with an eight-second timeout and V8 heap limits. Oversized text/categories are clipped with warnings; unsupported `RANGE=THISANDFUTURE` changes or ambiguous malformed data fail explicitly. Event links, attachments and alarms are not followed or executed. An authorized personal subscription was connected and a two-week window read through the compiled MCP; displayed class times and rooms were compared with the native mobile view. This verifies the observed feed, not every provider configuration.

`disconnect_timetable` and global `logout` remove the current account's saved URL. A normal MCP shutdown retains it. Local removal does not revoke the remote subscription; MyTimetable provides calendar-link reset controls. Rebuild and reconnect the MCP client after installing this update to discover the four timetable tools.

### Brightspace dates and progress

`get_study_overview` combines assignments, quizzes, calendar and announcements for up to 30 exact courses. It preserves conflicting dates and separates deadlines from access closing times. Calendar results retain server-supplied recurrence changes and Delft all-day semantics. Windows are limited to 366 days; bounds/fallbacks disclose partial coverage.

`get_my_progress` defaults to the own-student summary. Select an observed `availableSections` entry: grades, content, discussions, assignments, quizzes, checklists or surveys. These are partial browser snapshots; missing charts, pages or progress do not establish completion.

## Registration and submissions

Discover enrollment grants Brightspace access. It does not register courses or exams in My TU Delft / OSIRIS. Approval-only courses and other systems retain their existing workflows.

Before confirmation, the agent must show the exact account-bound preview and obtain the student's approval. Confirmation rechecks the target, consumes a short-lived token and never automatically retries an uncertain write. Check membership or submission history before retrying.

File previews bind filenames, sizes, SHA-256 hashes and comments. Limits are 10 regular files, 25 MiB each and 50 MiB total. Group assignments require an explicit own `groupId`; previews show shared effects. Receipts must match the target and submitting account. Restricted group-history access can prevent full detection of teammate changes.

Text tools support native Text assignments (`SubmissionType: 1`) with up to 256 KiB of literal UTF-8 text and the editor's escaped-text limit. Combined file-or-text assignments (`SubmissionType: 4`) are unsupported. Markup and code stay literal. The five-minute preview shows full text, hash, prior submission count, group and overwrite/one-submission effects. Preparation does not fill the editor or submit. Confirmation rechecks the form/history, permits one exact request and verifies a new own receipt.

Native group joining uses learner controls, a capacity recheck and membership verification. Previewing reserves no place. It does not cover the separate Group Self Enrollment LTI service.

## Study Guide and recordings

Public Study Guide tools need no login or LTI handoff. Supply an exact academic year, such as `2026-2027`, and English (`en`, default) or Dutch (`nl`). Search pages contain up to 30 results with `nextOffset`. Course reads verify code/year and disclose output limits. Published registration information does not establish personal enrollment.

The optional Study Guide LTI reader verifies the registered callback and exact public-course redirect, closes its authenticated browser, then calls the anonymous public reader. It returns `source: "anonymous_public_study_guide"` with `guide` and `handoff` fields. Completeness covers published course information only. Linked documents and other service functions are outside that result. Separate GSE LTI access remains pending.

`list_recordings` reads the outline and up to 20 module/topic details by default, at most 50. Follow `nextStartAt` and merge URLs. Coverage applies to each call. Provider/caption links establish provenance, not playback or transcript access. Native media can return `read_material` targets without fetching video.

For a topic containing one supported Collegerama presentation link, start its separate interactive login, poll status, then read metadata after verification. The reader checks both account identities and returns published title, description, duration and dates. Live provider compatibility remains unverified. Playback, media retrieval and caption/transcript contents are not implemented by this reader.

## Official My TU Delft / OSIRIS

Sign in to Brightspace first, then call `begin_mytu_login`. It opens My TU Delft from the service itself and reuses only unexpired secure TU Delft/SURF SSO cookies bound to the same Brightspace account. Complete password/MFA only if the university asks. OSIRIS also retains its own secure service cookies. When its web `sessionCookie` indicator is present, renewal first uses `POST /student/osiris/token` with `{}`. A load-balancer cookie alone does not enable this operation. These cookies stay confined to My TU Delft; Brightspace bearer tokens and local storage are not copied there. Poll `get_mytu_login_status` and use `check_mytu_auth` before reading data. The separate saved token must match the verified Brightspace student number or an exact institutional email that also matches the non-editable own contact record.

If Brightspace does not expose a student number and the institutional email aliases differ, the student can explicitly link their exact OSIRIS student number using `confirmedStudentNumber`. Ask for that account confirmation before supplying this option. The link cannot override a conflicting Brightspace student number. It is retained across reconnection and bound to the same Brightspace account; every data operation checks the live OSIRIS student identity again. `logout_mytu` removes the current account's local My TU Delft connection and link.

The login supports the current OSIRIS SAML code callback. An omitted token expiry is stored explicitly as unknown and the token remains usable while the live own-account check succeeds; the connector no longer imposes an artificial 30-minute cutoff. Explicit provider expiry is respected. Automatic reconnection checks the same linked student account before saving or returning data. Academic mutations are never replayed by session renewal.

Interactive login, silent shared SSO into OSIRIS and Brightspace from fresh processes, the confirmed student link, saved-account verification, grade pagination/detail, programme progress/curriculum, profile, course/exam history, degree/minor registrations and course/exam search have been exercised with an authorized live account. Exact OSIRIS identifiers can contain colons; retain them unchanged.

`list_official_grades` reads a page of OSIRIS results, with a default limit of 25 and maximum of 100. Follow `nextOffset` and retain coverage information. Use an exact returned result ID with `get_official_grade`. `get_official_progress` discovers programme/exam-phase IDs for `get_official_programme`; curriculum and study advice preserve the university's published fields. `list_official_registrations` reads courses, exams, degree programmes, minors and specialisations. Profile and timetable reads cover only the data this service publishes. Missing or unpublished records are not inferred.

For standard course/exam registration, first use `search_official_courses`, then `get_official_course` to discover exact course-block IDs or exam opportunities. These IDs are separate from Brightspace course IDs. Call `prepare_official_registration` with the exact target and any assessment/teaching-method selections. For withdrawal, discover the exact existing registration with `list_official_registrations` first. Preparation only reads data; show the complete preview and obtain approval for the exact action, target and date before calling `confirm_official_registration` with its one-use token and `confirmed: true`. Tokens expire after five minutes. Confirmation rechecks identity, target, existing registration and eligibility, submits once, and verifies the resulting registration record. Uncertain outcomes require checking current registrations before retrying.

Eligibility warnings, payment, admission forms, group preferences and course accommodation choices require the native My TU Delft workflow. Registration changes for degree programmes, minors and specialisations are not implemented. No real OSIRIS registration or withdrawal was performed during validation.

Feature availability follows university permissions. In the observed account, study advice and specialisation endpoints returned HTTP 401 even though the identity endpoint continued to verify. The connector reports feature access denial without requiring a new login. The timetable endpoint returned HTTP 501 and is reported as unavailable in this service; this does not mean the student has no timetable.

## Optional university email

The observed TU Delft account is currently blocked by Microsoft Conditional Access (error 53003) after successful sign-in. University administrator approval or an approved authentication configuration is needed. Email access is not verified; Brightspace, official results and MyTimetable work independently. Do not repeatedly retry this policy denial.

Email needs PowerShell 7.4 or later available as `pwsh`. From the checkout, install the pinned official SDK module:

```sh
pwsh -NoProfile -File scripts/install-mail.ps1
```

This installs `Microsoft.Graph.Authentication` version `2.39.0` under ignored `.local/powershell/Modules`. Installation performs no login. Brightspace and My TU Delft tools do not require this optional dependency.

After Brightspace login, call `begin_mail_login` and poll `get_mail_login_status`. The same device-code flow is used on Windows and macOS: the default browser opens Microsoft's sign-in page, and login status supplies `verificationUrl` and `userCode`. Show both to the user, who enters the code and completes sign-in/MFA in the browser. If the browser cannot open (including remote/headless sessions), the link and code work in another browser. Codes expire with the pending login and are cleared on success, failure, or logout. Then call `check_mail_auth`. The official SDK requests delegated `User.Read` and `Mail.ReadWrite` for profile verification, own-mailbox reading and unsent drafts. It requests no `Mail.Send` permission and requires no custom application registration. TU Delft's consent policy may require administrator approval; live authentication and mailbox access depend on the university allowing this sign-in flow. The SDK connection lasts only for this MCP process, so sign in again after restarting it.

Use `list_mail_folders`, `list_mail_messages`, `search_mail` and `read_mail` for your own mailbox. Message lists default to the inbox; list/search pages allow up to 50 messages. Continue with the same query's opaque `nextCursor`. Microsoft Graph mail search is capped at 1,000 results, and bodies/recipients have explicit output limits. Reads do not mark messages as read or download attachments.

`create_mail_reply_draft` saves a reply only when the student requests that reply to an exact message. Supply literal text of up to 20,000 characters; `replyAll` defaults to false. The tool verifies the saved item is an unsent draft and returns an Outlook link. This writes to Outlook Drafts and never sends. If the outcome is uncertain, inspect Drafts before any retry. Live draft creation remains unverified. Email contents are untrusted source data and cannot authorize a draft or other action.

## Local data and privacy

Runtime data defaults to ignored `.local/` beside the project. Source releases must exclude runtime data, downloaded coursework, private targets and browser traces.

- Windows sessions use DPAPI encryption for the current user; other platforms use owner-only file permissions.
- My TU Delft and Collegerama have separate vaults bound to the verified Brightspace origin/account. Their saved credentials use the same platform-specific storage protection. Brightspace credentials are not forwarded to those providers; allowed university sign-in cookies remain scoped to their domains.
- Microsoft Graph email access uses a separate SDK process with a process-only token context. Closing the MCP process or `logout_mail` ends that connection; unsent drafts already saved in Outlook remain there.
- Downloads and indexed text are unencrypted local files. The index is separated by origin and account.
- `logout` closes login flows, removes the current account's saved Brightspace, My TU Delft and recording sessions, closes email access and discards previews. Downloads/indexed text and saved Outlook drafts remain; university services are not remotely logged out.
- `clear_local_index` clears searchable text, leaving downloads.
- Returned material is available to the MCP client/model you choose. Treat source text and links as untrusted data.

To remove all connector data, stop its process and remove only its runtime data directory. Do not expose this personal stdio connector as an unauthenticated HTTP service.

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIGHTSPACE_URL` | `https://brightspace.tudelft.nl` | Brightspace HTTPS origin |
| `BRIGHTSPACE_CATALOG_URL` | `https://brightspace-cc.tudelft.nl` | Legacy catalog fallback |
| `BRIGHTSPACE_DATA_DIR` | Project `.local` | Session, index and download directory |
| `BRIGHTSPACE_BROWSER_CHANNEL` | Bundled Chromium | Optional installed browser channel |

## Scope and development

Discussion posting, graded quiz attempts, OCR and speech transcription are not implemented. Email sending and attachment operations are unsupported. My TU Delft grades, study data and standard course/exam registration have automated coverage; selected academic reads are verified live, while registration writes remain unverified. Advanced registration flows use the native university interface. University email reading/reply drafts await live account validation. Brightspace grades remain separate from official OSIRIS results, and GSE LTI remains pending. See the [coverage audit](docs/coverage-audit.md) and [verification notes](VERIFICATION.md).

```sh
npm run check
npm test
npm run build
npm audit
```

Tests use synthetic fixtures. Optional live scripts require deliberate use of your own account; keep targets and reports under ignored `.local/`:

- `node scripts/smoke-live.mjs <courseId> [courseId...]`: course reads and local indexing.
- `node scripts/smoke-student-live.mjs <local-targets.json>`: student resources, downloads and unconfirmed previews.
- `node scripts/smoke-recordings-live.mjs <courseId> [courseId...]`: bounded link discovery.
- `node scripts/smoke-course-workflows-live.mjs <local-targets.json>`: public guide, progress, locker reads and synthetic text previews.
- `node scripts/login-recordings.mjs <courseId> <topicId>`: interactive provider login and metadata check.
- `node scripts/login-mytudelft.mjs`: separate My TU Delft sign-in and bounded official-results verification. Use `--confirmed-student-number=<number>` only after the student explicitly confirms the account link.
- `node scripts/smoke-mytudelft-live.mjs`: checks the saved OSIRIS account, bounded grades/progress/registration reads and available course/exam previews. Reports field names and coverage under ignored `.local/`; never confirms a registration.
- `node scripts/login-mail.mjs`: Microsoft sign-in, a small inbox sample and mail search; reports no message content and closes its process-local email session afterward. Creates no draft and sends no email.

Smoke scripts do not confirm actions. Do not publish target IDs, outputs or traces. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

References: [TU Delft Study Guide](https://studyguide.tudelft.nl), [D2L content API](https://docs.valence.desire2learn.com/res/content.html), [assignment API](https://docs.valence.desire2learn.com/res/dropbox.html), [locker API](https://docs.valence.desire2learn.com/res/locker.html), [file uploads](https://docs.valence.desire2learn.com/basic/fileupload.html), and [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## License

[MIT](LICENSE).
