# Verification

This document describes source-level verification and its limits. Private account details, course identifiers, material filenames, browser traces and live-run reports are excluded from public documentation.

## Automated checks

### Exam planning and public campus readers

Six new tools add an on-demand exam-planning overview, SoftwareFinder search/detail,
Spacefinder catalogue search, teaching-room search and ICT notices. The official
public sites were read live with anonymous GET requests: software search/detail,
room search, both pages of a study-space query, incidents and maintenance. No
browser or university credentials are used for these public readers.

A read-only live exam overview used the existing account-bound OSIRIS and timetable
connections and returned complete current lists and timed conflict pairs. It did
not register for an exam, create reminders or change the timetable. Public readers
have synthetic format, route, response-size and pagination checks; the overview
has synthetic conflict, partial-failure, account-switch and bounded-pagination
checks. MCP schema/annotation coverage includes all six tools.

Ans and Queue are researched but not integrated. Queue's silent SSO reached a
password prompt. Ans's authenticated student routes remain unverified. Campus
Print still has only the separate local foundation described below.

The current source passed on Windows with Node 25 and PowerShell 7:

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm test` | 539 passed, 0 failed, 0 skipped |
| `npm run build` | Passed |
| `npm audit` | No known vulnerabilities at the recorded check |
| MCP interface | 84 tools; startup/shutdown and structured JSON-RPC output covered; compiled timetable worker and tool discovery smoke passed |

Dependencies and service behavior can change. Run these checks in the current checkout rather than treating this table as a permanent guarantee.

### Printing foundation (not connected to MCP)

The local `PrintActions` foundation has 15 synthetic tests covering file hashes,
explicit settings, account/quote changes, one-use and expired previews, concurrent
confirmation, cancellation and uncertain outcomes. Focused coverage is 100% of
lines and 97.5% of branches. The full 519-test suite, typecheck, build and
credential-free MCP smoke passed on Windows. That foundation added no MCP tools.

This proves local approval behavior with a fake transport only. There is no Campus
Print provider adapter, authenticated queue verification, payment integration or
printing MCP tool. Public portal and vendor documentation were inspected; a
headless SSO attempt required sign-in, and authenticated inspection did not finish.
No document was uploaded and no print job or payment was created. See [TODOs](TODO.md).

The silent-refresh update passed the full suite, build and credential-free startup smoke on Windows. Focused client/Collegerama tests reached 94.04% combined line coverage. A separate read-only check refreshed the saved Brightspace credentials and reverified the same account with zero browser launches and zero submission requests. Automatic Collegerama renewal and the visible-login opt-in are verified with synthetic fixtures; this update does not claim a new live login test for every provider or platform.

All four visible login tools now require literal `interactive: true`. Routine Brightspace uploads refresh credentials before sending file bytes, preserve account binding across renewal and never retry a submission POST. Course-page readers and existing Collegerama sessions use bounded silent reconnection; password requirements stop without a visible fallback. Email retains its process-local SDK session policy.

A fresh source-only installation of this update passed `npm ci`, Chromium installation, typecheck, build, credential-free MCP startup/resource discovery and generated host configuration with all 78 tools. It contained no university sessions or downloaded student data and did not require the optional mail SDK. The new `scripts/smoke-install.mjs` also runs in CI on Windows, Ubuntu and macOS; Windows installs the pinned Graph SDK for offline compatibility checks. Automated tests do not log into university services.

Release read checks from a fresh compiled process verified Brightspace authentication, course listing/content/announcements/assignments, My TU Delft authentication, bounded official grades, degree progress and a two-week personal timetable. Private results are excluded from this repository.

Tests use synthetic documents, mocked responses and locally served browser fixtures. They cover:

- Session encryption, account binding, fresh-login recovery, cancellation and guarded vault replacement.
- Authenticated request/download confinement, redirects, response bounds and pagination.
- Office, PDF, tabular and notebook extraction, archive limits, truncation reporting and PDF worker diagnostics/timeouts.
- Per-account indexing, changed document refresh, full-text search and exact source reopening.
- Course metadata fallback, provenance, continuation and partial coverage.
- Calendar occurrences, Delft all-day dates and daylight-saving boundaries.
- MyTimetable subscription URL confinement, credential-free requests, account binding, guarded replacement, cancellation, private-link redaction from results, schema forwarding and logout cleanup.
- iCalendar UTC/floating/IANA/embedded timezones, DST, all-day exclusive ends, recurrence exclusions, moved instances, UTC/local recurrence identity, cancellation-only exceptions, unrelated series, output bounds and sanitized worker errors.
- Own groups, progress sections, student-file ownership, published feedback and locker path/file checks.
- Anonymous exact-year Study Guide search/read and the verified LTI-to-public continuation.
- Course/group enrollment and file/text submission previews, one-use confirmation, stale-target rejection and receipt verification.
- Recording discovery, caption association, hidden-parent suppression and output limits.
- Separate Collegerama guards, identity matching, redirects, cancellation and metadata parsing.
- Shared TU/SURF SSO cookie scope, account binding, rotation, deletion, concurrent snapshots, logout and cancellation during persistence.
- Brightspace automatic SSO after token-renewal failure, concurrent reads, account mismatch and required-interaction handling.
- My TU Delft SSO isolation, SAML code callback confinement, unknown expiry with live validation, native cookie renewal, bounded silent SSO, account changes/cancellation, exact own-student routes, identity matching, explicit account links and their reconnection, pagination and guarded token storage.
- OSIRIS programme discovery, curriculum/advice reads, bounded course search, original academic fields, exact registration previews, changed dates, existing registrations, eligibility warnings, account changes, one-use confirmation and uncertain write outcomes.
- OSIRIS typed/compound identifiers, feature-specific denial with a valid login and explicit upstream HTTP 501 reporting.
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
| My TU Delft identity | Interactive sign-in, explicitly confirmed student link, saved token and live identity revalidation |
| Shared university sign-in | Fresh-process silent OSIRIS reconnection with its service cookies excluded; silent Brightspace reconnection with its service cookies, bearer and local storage excluded; both verified the previously linked account |
| Official grades and study data | Two grade pages, exact grade detail, programme progress/curriculum, own profile, current/historical course/exam records, degree/minor registrations and course/exam catalogue search |
| Official registration discovery | An available exam opportunity and its eligibility check; a provider warning correctly stopped preview creation, with no registration sent |
| MyTimetable | Interactive university login, authorized native subscription retrieval, encrypted connection, status and two-week live read through the compiled MCP; class times/rooms compared with the native mobile schedule |

The Study Guide continuation returns `guide` and `handoff` fields with `source: "anonymous_public_study_guide"`. Completeness is scoped to published course information. It does not establish access to every linked document or service function.

Private evidence stays in ignored runtime storage. It must not be attached to public issues or included as test fixtures.

The shared SSO checks used cookies saved after a new verified OSIRIS sign-in. Both fresh-process service reconnections completed without password/MFA interaction. This verifies session persistence and cross-service reuse while the university accepts that SSO session; it does not establish an unlimited session lifetime. The older timetable SSO snapshot had failed an earlier silent attempt. The tested OSIRIS deployment issued only an affinity cookie, without the native application's `sessionCookie` indicator: an initial cookie-only probe returned HTTP 400 and fell back successfully to SSO. The final implementation checks that indicator before attempting optional cookie renewal. Synthetic tests cover the native empty-object token POST, cookie rotation, affinity-only exclusion and fallback; successful cookie-only renewal remains unverified for this deployment.

An authorized MyTimetable personal subscription was retrieved directly from the signed-in native mobile connection page, transferred locally without exposing the link in chat, and saved in the account-bound vault. A subsequent compiled MCP process read the saved connection and returned the requested two-week schedule without parser warnings. The native connection page disclosed that subscription selections differed from visible web/mobile selections; the additional feed entries were retained and distinguished, with no selection changes. This verifies the observed feed and operates independently of the unavailable OSIRIS timetable route. Recurrence edge cases beyond the live feed remain covered with synthetic tests.

## Limits

Interactive Brightspace login completed in the current live session and its own-account identity was verified. A failed fresh login preserves an existing saved session, but that does not establish the reason for an upstream sign-in failure.

Separate GSE LTI access remains pending. Collegerama login and metadata handling have automated coverage, but successful live provider identity/metadata compatibility remains unverified. Recording links do not establish playback or transcript access.

My TU Delft sign-in completed the provider SAML callback and token exchange. Brightspace did not expose a student number and returned a different institutional email alias. After the student explicitly confirmed the account, the connector saved its account-bound link and verified it on subsequent academic reads. Grade and programme IDs use typed/compound colon-separated forms; the live check exposed and corrected the earlier overly narrow validation.

The expanded OSIRIS routes and registration payloads were inspected in the JavaScript served by the current official My TU Delft application. Selected academic reads listed above succeeded live. Study advice and specialisation reads returned HTTP 401 while identity checks still succeeded; the connector reports feature denial. The timetable endpoint returned HTTP 501, so its data shape remains unverified and the feature is reported as unavailable. Synthetic registration responses verify implementation behavior; they do not prove that the provider accepts writes. University email uses the official Microsoft Graph PowerShell application; consent restrictions may prevent access. No live email draft has been created or sent.

Catalogue search can return published courses without available registration details; one such detail read returned 404 and its course-block list was empty. A separate open exam returned its opportunity and an eligibility warning. The connector stopped before a confirmable preview. Successful live enrollment/withdrawal previews and persisted writes remain unverified. Native decimal clock serialization is covered with synthetic examples.

No real course enrollment, group join or assignment submission was performed as part of the documented validation. Confirmation handling is tested with synthetic or intercepted requests; live preview success does not prove a persisted write will succeed. Limited group-history permissions may prevent detection of concurrent teammate changes.

Unavailable or broken upstream items produce explicit gaps. Search covers retrieved cached text and does not automatically purge removed items. Browser snapshots and bounded listings may omit further pages or hidden details. Missing dates or progress never establish that work is absent or complete.

PDF workers impose time and V8 heap bounds, not operating-system memory isolation. Downloaded/indexed course text is unencrypted local data. Automated core checks passed on Windows, Ubuntu and macOS; live provider access and optional email SDK compatibility require separate verification on each platform.

OSIRIS degree/minor/specialisation registration changes, advanced course registration choices, email sending and attachments, graded quiz attempts, discussion posting, OCR and speech transcription are outside the implemented scope. Standard OSIRIS course/exam registration and timetable reads are implemented with the live-validation limits above. See the [coverage audit](docs/coverage-audit.md).

## Reproducing checks

Run the automated commands from the repository root. Optional live scripts are described in the [README](README.md); they require deliberate use of your own account and exact tool-returned targets. Never publish their target files, private output, screenshots or browser state.

## Email browser login update (2026-09-15)

Replaced Windows WAM parent-window allocation with the official SDK device-code browser flow on all platforms. The worker forwards only an allowlisted Microsoft verification URL and display code; tokens remain in the SDK process. Login status clears the code on success, failure and logout. Browser opening uses the Windows default URL handler, macOS `open`, or Linux `xdg-open`; the manual link remains available.

Validation: `npm run check`, `npm run build`, and 47 passing tests in `tests/university-mail.test.ts` and `tests/server.test.ts`. Tests cover both SDK prompt URL forms, raw and structured worker events, invalid prompts, browser launch command selection, stale login events, logout, mailbox restrictions, and the installed SDK transport. A live Windows SDK login produced a code and launched the browser. The first live attempt timed out before authentication completed; mailbox access is still unverified. macOS/Linux live sign-in has not been run here. Already-running MCP processes need a restart to load the changed JavaScript.

Live follow-up: Microsoft sign-in with the correct NetID succeeded, but Conditional Access blocked the Graph application with error 53003. The exact policy requires university administrator review. Email reading and drafts remain unverified; further login retries are stopped. Earlier GET/POST handoff errors do not explain or remove this confirmed policy block.
