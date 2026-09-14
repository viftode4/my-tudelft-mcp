# TU Delft Brightspace MCP

A local MCP server for everyday TU Delft coursework. Connect it to Codex or another MCP client, sign in through the normal university browser, then use course tools through your agent.

This repository publishes the source for a personal connector. It runs on your computer with your own Brightspace session, D2L APIs and scoped browser readers. It needs no hosted backend, dashboard, model API key or institutional OAuth application registration. Session reuse is unofficial and may need maintenance when university services change.

## Install

Requires Node.js 22.13 or later with built-in SQLite support, npm, and a graphical session for login. Windows with Node 25 is the tested platform; other platforms have more limited validation.

Clone this repository, then install from the checkout:

```sh
git clone https://github.com/viftode4/tudelft-brightspace-mcp.git
cd tudelft-brightspace-mcp
npm ci
npx playwright install chromium
npm run build
npm run login
npm run doctor
```

Complete TU Delft sign-in and MFA in the opened browser. Passwords and MFA codes belong there, never in agent messages or tool arguments. `doctor` verifies the saved session without printing credentials.

When the session expires, call `begin_login`, complete sign-in, then check `get_login_status` and `check_auth`. For a clean attempt, use `begin_login` with `fresh: true`, or `npm run login -- --fresh`. This starts from Brightspace without saved sign-in cookies. Failure preserves the previous session; replacing it requires verified identity. Begin from the service itself rather than a copied SSO callback URL.

## Connect an MCP client

Replace the placeholder with your checkout's absolute path:

```sh
codex mcp add tudelft-brightspace -- node /absolute/path/to/tudelft-brightspace-mcp/dist/cli.js serve
```

On Windows, use the full Windows path to the same entrypoint. Start a new Codex conversation after adding the server. For longer operations, configure suitable timeouts:

```toml
[mcp_servers.tudelft-brightspace]
command = "node"
args = ["/absolute/path/to/tudelft-brightspace-mcp/dist/cli.js", "serve"]
startup_timeout_sec = 20
tool_timeout_sec = 180
```

See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) and [generic client example](mcp.example.json). Run the Node entrypoint directly in MCP clients: stdout carries MCP, while diagnostics go to stderr. An `npm start` wrapper adds output that can disrupt the protocol.

## Example requests

- "Show my courses and their latest announcements."
- "Read these lecture slides with page references."
- "Index this course, then find material about the topic I'm revising."
- "Show upcoming assignments, quiz dates and calendar events."
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
| Submitted files and feedback | `read_my_submission_file`, `read_assignment_feedback_file` | Own submitted files and published feedback |
| Groups and progress | `get_my_groups`, `get_my_progress` | Own memberships and observed progress sections |
| Shared group locker | `read_group_locker`, `list_group_locker_files`, `read_group_locker_file` | Scoped listing, reading, indexing and downloads |
| Group enrollment | `list_available_groups`, `prepare_group_enrollment`, `confirm_group_enrollment` | Native group discovery and previewed joining |
| Linked services | `read_course_service` | Verified Study Guide continuation; GSE access remains pending |
| Calendar and quizzes | `get_calendar`, `get_upcoming_deadlines`, `get_study_overview`, `list_quizzes` | Sourced dates and course overview |
| Lectures | `read_material`, `download_material` | Bounded extraction and optional downloads |
| Recording discovery | `list_recordings` | Recording/caption links with provenance |
| Collegerama | `begin_recording_login`, `get_recording_login_status`, `read_recording` | Separate login and metadata; live provider compatibility unverified |
| Local search | `start_course_sync`, `get_sync_status`, `search_course_materials`, `get_index_status`, `clear_local_index` | Per-account full-text index and timestamps |
| Browser reader | `read_course_page` | Scoped page text, links and media metadata |
| Brightspace access | `search_catalog`, `prepare_course_registration`, `confirm_course_registration` | Discover search and previewed enrollment |
| File submissions | `prepare_assignment_submission`, `confirm_assignment_submission` | Exact file previews and confirmed submission |
| Text submissions | `prepare_text_submission`, `confirm_text_submission` | Literal-text previews and confirmed submission |

The server exposes 50 tools. The `brightspace://usage` resource describes workflows; `course_briefing` supplies a sourced briefing template.

## Reading and search

Search covers retrieved text. Call `start_course_sync`, poll `get_sync_status`, inspect coverage/errors, and continue with `nextStartAt` when supplied. Results include exact supported `readTool` arguments for reopening live sources.

Supported formats include PDF, DOCX, PPTX with speaker notes, XLSX, CSV/TSV, Jupyter notebooks, HTML, text, Markdown and VTT/SRT captions. Pages, slides, spreadsheet cells and notebook cells are labelled. Code and formulas are never executed; saved output can be stale. Image-only PDFs require OCR, which is not included. Charts, binary notebook output and widgets are omitted with warnings.

Files are limited to 50 MiB, extracted text to 2,000,000 characters, and archive expansion/page counts are bounded. Notebook output is capped at 20,000 characters per output and 500,000 in total. PDF parsing uses a worker with a 30-second timeout and V8 heap limits; these are not operating-system memory isolation.

Student-file readers support chunked text and optional downloads. Extracted text is indexed for the verified account before chunking. An indexing error is reported without discarding a successful read. Unsupported binaries such as ZIP files can be downloaded within the size limit but are not text-indexed.

Locker listing reads one own-group folder at a time, with `nextStartAt` continuation. File reading rechecks membership, every parent folder and the exact observed path. No recursive folder scan, upload, rename or folder change is implemented.

Sync cannot infer deletion from partial listings. Removed items can remain cached until `clear_local_index` and a new sync. Search identifies cached content and retrieval time.

## Dates and progress

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

## Local data and privacy

Runtime data defaults to ignored `.local/` beside the project. Source releases must exclude runtime data, downloaded coursework, private targets and browser traces.

- Windows sessions use DPAPI encryption for the current user; other platforms use owner-only file permissions.
- Collegerama has a separate vault bound to Brightspace origin/account. Brightspace credentials are not forwarded; allowed university sign-in cookies remain scoped to their domains.
- Downloads and indexed text are unencrypted local files. The index is separated by origin and account.
- `logout` closes login flows, removes current connector sessions and discards previews. Downloads/indexed text remain; university services are not remotely logged out.
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

My TU Delft / OSIRIS grades and official registration, university email reading/search/drafts, separate timetables, discussion posting, graded quiz attempts, OCR and speech transcription are not implemented. Brightspace grades are separate from official study records. See the [coverage audit](docs/coverage-audit.md) and [verification notes](VERIFICATION.md).

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

Smoke scripts do not confirm actions. Do not publish target IDs, outputs or traces. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

References: [TU Delft Study Guide](https://studyguide.tudelft.nl), [D2L content API](https://docs.valence.desire2learn.com/res/content.html), [assignment API](https://docs.valence.desire2learn.com/res/dropbox.html), [locker API](https://docs.valence.desire2learn.com/res/locker.html), [file uploads](https://docs.valence.desire2learn.com/basic/fileupload.html), and [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## License

[MIT](LICENSE).
