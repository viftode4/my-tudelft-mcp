# Verification

This document describes source-level verification and its limits. Private account details, course identifiers, material filenames, browser traces and live-run reports are excluded from public documentation.

## Automated checks

The documented source baseline passed on Windows with Node 25:

| Check | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm test` | 355 passed, 0 failed, 0 skipped |
| `npm run build` | Passed |
| `npm audit` | No known vulnerabilities at the recorded check |
| MCP interface | 50 tools; startup/shutdown and structured JSON-RPC output covered |

Dependencies and service behavior can change. Run these checks in the current checkout rather than treating this table as a permanent guarantee.

Release preparation also verified a fresh source-only checkout: `npm ci`, typecheck, all 355 tests, build, and a compiled MCP startup exposing 50 tools. The checkout contained no saved university session or downloaded student data.

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

No real course enrollment, group join or assignment submission was performed as part of the documented validation. Confirmation handling is tested with synthetic or intercepted requests; live preview success does not prove a persisted write will succeed. Limited group-history permissions may prevent detection of concurrent teammate changes.

Unavailable or broken upstream items produce explicit gaps. Search covers retrieved cached text and does not automatically purge removed items. Browser snapshots and bounded listings may omit further pages or hidden details. Missing dates or progress never establish that work is absent or complete.

PDF workers impose time and V8 heap bounds, not operating-system memory isolation. Downloaded/indexed course text is unencrypted local data. Windows is the verified platform; other operating systems require their own validation.

My TU Delft / OSIRIS grades and registration, university email reading/search/drafts, separate timetables, graded quiz attempts, discussion posting, OCR and speech transcription are outside the implemented scope. See the [coverage audit](docs/coverage-audit.md).

## Reproducing checks

Run the automated commands from the repository root. Optional live scripts are described in the [README](README.md); they require deliberate use of your own account and exact tool-returned targets. Never publish their target files, private output, screenshots or browser state.
