# Verification

This document describes source-level verification and its limits. Private account details, course identifiers, material filenames, browser traces and live-run reports are excluded from public documentation.

## Automated checks

The current source passed on Windows with Node 25 and PowerShell 7:

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm test` | 415 passed, 0 failed, 0 skipped |
| `npm run build` | Passed |
| `npm audit` | No known vulnerabilities at the recorded check |
| MCP interface | 65 tools; startup/shutdown and structured JSON-RPC output covered |

Dependencies and service behavior can change. Run these checks in the current checkout rather than treating this table as a permanent guarantee.

A fresh source-only installation also passed `npm ci`, typecheck, build and compiled MCP startup with all 65 tools. It contained no saved university session or downloaded student data, and the optional mail SDK was not required for startup. CI runs on Windows, Ubuntu and macOS; Windows installs the optional pinned Graph SDK for offline compatibility checks. Automated tests do not log into Microsoft or university services.

Tests use synthetic documents, mocked responses and locally served browser fixtures. They cover:

- Session encryption, account binding, fresh-login recovery, cancellation and guarded vault replacement.
- Authenticated request/download confinement, redirects, response bounds and pagination.
- Office, PDF, tabular and notebook extraction, archive limits, truncation reporting and PDF worker diagnostics/timeouts.
- Per-account indexing, changed document refresh, full-text search and exact source reopening.
- Course metadata fallback, provenance, continuation and partial coverage.
- Calendar occurrences, Delft all-day dates and daylight-saving boundaries.
- Own groups, progress sections, student-file ownership, published feedback and locker path/file checks.
- Anonymous exact-year Study Guide search/read and the verified LTI-to-public continuation.
- Course/group enrollment and file/text submission previews, one-use confirmation, stale-target rejection and receipt verification.
- Recording discovery, caption association, hidden-parent suppression and output limits.
- Separate Collegerama guards, identity matching, redirects, cancellation and metadata parsing.
- Separate My TU Delft login, exact official-result routes, identity matching, pagination and guarded token storage.
- Own-mailbox Graph routes, institutional identity/tenant checks, process-local sessions, bounded pagination, unsent draft verification and unknown-write outcomes.
- MCP schemas and cleanup across linked services, including continued logout after another provider's local cleanup fails.

## Live validation scope

Selected read-only and preview workflows have also been exercised through the compiled MCP using a developer's own authorized account. This establishes observed compatibility, not universal availability across courses, roles or future university configurations.

| Surface | Validation scope |
| --- | --- |
| Brightspace session and memberships | Saved-session identity and paginated own-course discovery |
| Course information | Outlines, announcements, assignments, grades, quiz metadata, discussions and calendar |
| Files and local search | Supported materials and student attachments, bounded extraction, indexing, source reopening and byte-checked downloads |
| Groups and progress | Own membership, native group discovery, selected progress sections and discarded previews |
| Group locker | Exact API folder/file membership and binary download; text indexing covered with synthetic fixtures |
| Public Study Guide | Anonymous exact code/year search and published sections |
| Study Guide LTI | Registered callback, exact public redirect, closed authenticated context and anonymous reader |
| Recording discovery | Bounded metadata links, continuation and explicit upstream gaps |
| Text submissions | Literal-text previews and native serialization intercepted before a real submission |

The Study Guide continuation returns `guide` and `handoff` fields with `source: "anonymous_public_study_guide"`. Completeness is scoped to published course information. It does not establish access to every linked document or service function.

Private evidence stays in ignored runtime storage. It must not be attached to public issues or included as test fixtures.

## Limits

Fresh interactive Brightspace login completion after the latest recovery changes remains unverified. A failed fresh login preserves an existing saved session, but that does not establish the reason for an upstream sign-in failure.

Separate GSE LTI access remains pending. Collegerama login and metadata handling have automated coverage, but successful live provider identity/metadata compatibility remains unverified. Recording links do not establish playback or transcript access.

My TU Delft results and university email are implemented, but successful live account checks remain pending. The My TU Delft browser flow has reached the normal university password form; that does not prove completed authentication, cross-service account matching or access to official grades. Email uses the official Microsoft Graph PowerShell application; university consent restrictions may still prevent access. No live email draft has been created or sent.

No real course enrollment, group join or assignment submission was performed as part of the documented validation. Confirmation handling is tested with synthetic or intercepted requests; live preview success does not prove a persisted write will succeed. Limited group-history permissions may prevent detection of concurrent teammate changes.

Unavailable or broken upstream items produce explicit gaps. Search covers retrieved cached text and does not automatically purge removed items. Browser snapshots and bounded listings may omit further pages or hidden details. Missing dates or progress never establish that work is absent or complete.

PDF workers impose time and V8 heap bounds, not operating-system memory isolation. Downloaded/indexed course text is unencrypted local data. Automated core checks passed on Windows, Ubuntu and macOS; live provider access and optional email SDK compatibility require separate verification on each platform.

Official My TU Delft / OSIRIS course and exam registration, email sending and attachments, separate timetables, graded quiz attempts, discussion posting, OCR and speech transcription are outside the implemented scope. See the [coverage audit](docs/coverage-audit.md).

## Reproducing checks

Run the automated commands from the repository root. Optional live scripts are described in the [README](README.md); they require deliberate use of your own account and exact tool-returned targets. Never publish their target files, private output, screenshots or browser state.
