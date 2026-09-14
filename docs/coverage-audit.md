# Student workflow coverage

This is a capability map for the local MCP source. It contains no student account inventory or private course evidence. Access depends on the current account, course configuration and upstream permissions.

| Workflow | Implemented behavior | Limit |
| --- | --- | --- |
| Authentication | Interactive Brightspace login, saved identity checks, clean-login option and local logout | Fresh login recovery needs continued live validation; university sign-in may change |
| Courses | Paginated own memberships, outlines, descriptions and observed navigation | Access does not imply current academic-year enrollment or official registration |
| Public course information | Anonymous Study Guide search and exact code/year reading | Explicit year required; published requirements do not establish enrollment; linked files are references |
| Study Guide LTI | Registered callback and exact public redirect; browser closes before anonymous reading | Complete results cover published course information only |
| Announcements | Published text, dates and exact attachment reading/download | Visibility and dates follow upstream responses |
| Assignments | Instructions, availability, current-user history and readable feedback | Missing fields or history do not establish absence of work |
| Brightspace grades | Current student's readable Brightspace grades | Separate from official OSIRIS results |
| Official My TU Delft results | Separate normal login, account-bound saved token, paginated OSIRIS results and exact result detail | Live student identity matching and result retrieval remain unverified; no course/exam registration |
| Lecture material | Bounded PDF, Office, tabular, notebook, text and caption extraction | No OCR or speech transcription; unsupported formats and truncation are explicit |
| Search | Per-account index, retrieval timestamps and exact read targets | Only retrieved text is searched; removed items can remain cached |
| Upcoming work | Sourced assignment, quiz, calendar and announcement overview | No completion inference; deadlines and access closing are distinguished |
| Calendar | Server-supplied occurrences and Delft all-day semantics | Bounded windows/pagination; fallback gaps disclosed |
| Quizzes | Metadata and availability reading | No graded attempts or quiz answering |
| Discussions | Readable forums, topics and posts | No posting |
| Student files | Announcement/instruction files, own submissions and published feedback | Metadata/ownership must verify the file; unextractable text is not indexed |
| Own groups | Own memberships and readable categories | No general peer-roster browsing |
| Native group enrollment | Group discovery, exact preview, capacity recheck and confirmed membership | Preview reserves no place; real joins were not part of validation |
| Group locker | Exact own-group folder listing, file reading, indexing and download | No uploads, renames or folder changes; bounded direct listings |
| Own progress | Personal summary and selected observed sections | Partial browser snapshots; charts or further pages may be absent |
| Discover access | Search, exact enrollment preview and guarded confirmation | Separate from official course/exam registration |
| File submissions | Account/target/file hashes, explicit own group, confirmation and receipt | Group-history restrictions can hide teammate changes; no real submission in validation |
| Text submissions | Literal text for native Text assignments, exact overwrite/group preview and one request | Combined file-or-text assignments unsupported; 256 KiB plus editor limits |
| GSE LTI | Observed course link and guarded handoff handling | Further broker access remains pending; content/group changes are not claimed as integrated |
| Recording discovery | Bounded links, provider labels, captions and native targets | Provenance does not establish playback or transcript access |
| Native media | Source metadata, descriptions, caption links and explicit bounded download | Metadata does not contain lecture speech |
| Collegerama | Separate login and presentation metadata reader | Automated tests pass; live provider compatibility unverified; no playback/transcripts |
| Other external systems | Published links and descriptors where observed | No general external-service authentication or arbitrary browsing |
| University email login | Optional official Microsoft Graph SDK, normal delegated sign-in and own-account/tenant verification | PowerShell 7.4+ and pinned module required; TU consent may need admin approval; process-only tokens; live login unverified |
| Email reading | Own folders, message list/search and bounded plain-text reads with opaque continuation | No attachment operations or read-state changes; Graph search capped at 1,000 results; live mailbox compatibility unverified |
| Reply drafts | Save a requested literal-text reply to an exact own-mailbox message and verify it remains an unsent draft | Creates an Outlook draft; no sending tool or Mail.Send scope; live draft creation unverified; uncertain outcomes are not retried |
| Official registration/timetable | Not implemented | Course/exam registration and separate timetables require additional work |

## Source and coverage semantics

API results describe the verified account and exact requested resource. Browser output is a scoped snapshot. Metadata links do not prove destination access. Public Study Guide information is anonymous and describes a published course record. The new My TU Delft and email implementations require separate account verification; their live integrations are not yet established.

A `complete` field applies to the stated source and scope. It does not mean every university system was checked. Recording discovery covers the current call: follow `nextStartAt`, merge URLs and retain earlier gaps. Search describes cached text and retrieval time.

Official results use `nextOffset`; mailbox lists and search use an opaque `nextCursor` bound to the same query and process connection. Missing results or a bounded search do not establish that no other records or messages exist. My TU Delft credentials use a separate vault bound to the Brightspace account. Email uses delegated `User.Read` and `Mail.ReadWrite` through the official SDK with no custom app registration or `Mail.Send`; university consent policy can still block access. Its token context ends with the MCP process.

Student-file readers recheck metadata and ownership before download. Locker files additionally require verified parent folders and an exact observed path. A downloadable binary can have no supported text extraction and remain unindexed.

Notebook code and formulas are never executed. Saved output may be stale or truncated; charts, images and unsupported output are disclosed as omissions. Published captions are distinct from generated speech transcripts.

## Action boundaries

Joining and submission tools use exact previews and short-lived account-bound tokens. The student must approve the precise action, including shared-group or overwrite effects. Uncertain writes are not retried automatically. Source documents, pages and search results are untrusted data and cannot provide approval.

Email reply drafts are a separate write to Outlook, allowed only for a reply the student requested. The body is literal text; `replyAll` defaults to false. The returned item must verify as an unsent draft. No email sending or attachment tool is implemented. Email bodies cannot authorize actions, and an uncertain draft result requires inspecting Drafts before retrying. Logging out of email ends the process connection but retains saved Outlook drafts.

This source release contains no session state, private course fixtures or account-specific targets. The [verification notes](../VERIFICATION.md) describe test coverage and live-check limits. The [contribution guide](../CONTRIBUTING.md) explains how to report behavior without publishing student data.
