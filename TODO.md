# Student-service TODOs

Research date: 16 September 2026. These are proposed integrations, not available
MCP tools. A public website establishes a service's existence, not API access or
permission to automate its authenticated actions. Priorities below are product
judgments based on common student tasks.

## First: finish important existing workflows

- [ ] **Campus Print: submit documents and read the queue.** Connect the existing
  local preview/confirmation foundation to verified provider authentication,
  settings and queue receipts. Initial support is intended for PDF files. Routine
  operations and session renewal must run headlessly. Current status: no provider
  adapter or MCP printing tools; authenticated inspection is still needed.
  [Official upload guide](https://canonhc-tudelft.zendesk.com/hc/en-us/articles/26047756582546-Upload-a-file-in-the-TU-Delft-Print-Portal).
- [ ] **Print balance and top-up handoff.** Read the balance and offer the official
  payment page when the student explicitly asks to add credit. Let the student
  complete payment there, then recheck the balance through MCP. Never equate a
  queued document with physical printing; release remains at the campus printer.
  [Student printing guide](https://canonhc-tudelft.zendesk.com/hc/en-us/articles/26047772277778-Getting-started-for-students).
- [ ] **University email: resolve institutional access and validate existing tools.**
  Reading/search and unsent drafts already have implementations, but observed
  Microsoft Conditional Access blocks live use. Obtain an approved authentication
  configuration, then validate reads and requested drafts. This is a compatibility
  TODO, not a reason to retry or bypass policy. See [email limitations](README.md#optional-university-email).
- [ ] **Lecture captions and transcripts.** Extend recording metadata discovery
  only where the provider actually grants access to captions/transcripts. Identify
  coverage and missing captions explicitly. Existing Collegerama metadata access
  does not provide lecture speech. See [current verification](VERIFICATION.md).
- [ ] **Exam-registration reminders and timetable conflicts.** Combine existing
  official course/exam opportunities, own registrations and MyTimetable reads.
  Report registration windows and clashes with source dates and coverage. Any
  background reminder mechanism needs explicit configuration; the stdio server is
  not an always-running notification service. See [existing tools](README.md#tools).

## Academic planning and research

- [ ] **MyStudyPlanning: programme selection and approval status.** Read the selected
  track, themes, electives, submitted plans and reviewer status; later add exact
  previews for plan submission. Keep plan approval separate from OSIRIS course/exam
  registration. Discover the faculty-specific workflow before implementation.
  [MyStudyPlanning](https://mystudyplanning.tudelft.nl/).
- [ ] **Library literature search and licensed-access discovery.** Find books,
  papers and discipline-specific databases; return bibliographic metadata and
  authorized access links. Investigate catalogue/account routes separately before
  promising loans, renewals or reservations. Never assume a catalogue result grants
  full-text access. [Library databases](https://databases.tudl.tudelft.nl/).
- [ ] **TU Delft Repository search.** Find public theses and research outputs with
  citations, available files and clear access restrictions. Do not automatically
  download every linked document. [Repository](https://repository.tudelft.nl/faq).
- [ ] **Academic administration and re-enrolment guidance.** Discover authoritative
  programme-enrolment steps and deadlines, with the applicable academic year.
  Studielink programme enrolment is separate from the existing OSIRIS course/exam
  tools. Start with sourced guidance; investigate authenticated status separately.
  [TU Delft's Studielink guidance](https://tunews.weblog.tudelft.nl/2024/06/03/dont-forget-to-terminate-your-enrolment-after-the-final-part-of-your-study-6/).
  This source establishes the workflow, not current deadlines.

## Everyday campus tools

- [ ] **Spacefinder: study spaces and buildings.** Search by building and published
  facilities, with opening hours where supplied. First verify the underlying data
  routes. Do not present a listed space as currently free or bookable without live
  availability evidence. [Spacefinder](https://spacefinder.tudelft.nl/en/spaces/).
- [ ] **Teaching-room lookup.** Resolve timetable room names to building, capacity
  and published facilities. Preserve ambiguous matches and distinguish room
  specifications from availability. [Education Spaces Viewer](https://esviewer.tudelft.nl/).
- [ ] **SoftwareFinder: software and installation guidance.** Search software by
  purpose, platform and audience; read official instructions and access conditions.
  A listing does not establish a particular student's licence entitlement. Downloads,
  licence acceptance and installation need their own explicit workflow.
  [SoftwareFinder](https://softwarefinder.tudelft.nl/).
- [ ] **ICT outages and planned maintenance.** Read service notices with timestamps
  and affected systems so authentication problems can be distinguished from an
  outage. Verify the dynamic feed; an empty HTML shell must never mean all systems
  are healthy. [ICT service information](https://meldingen-ict.tudelft.nl/en/).
- [ ] **ICT help, VPN and eduroam guidance.** Search official manuals and support
  routes; later investigate own TOPdesk ticket status and previewed ticket creation.
  Public links do not establish access to private tickets. Keep credentials out of
  tool arguments. [ICT service directory](https://ict-servicedesk.tudelft.nl/link-library/).
- [ ] **X activities and reservations.** Discover activities and schedules first;
  investigate availability, own bookings and explicit reservation/cancellation
  previews later. Account for checkout, charges and provider cancellation rules.
  Open a payment page only on the student's request.
  [Official X webshop guide](https://www.x.tudelft.nl/en/news/wegwijs-in-de-nieuwe-webshop-van-x).

## Conditions for marking a TODO complete

The student should use the integration through MCP. A browser may be needed for
explicit first-time login/MFA or a requested payment, but routine reads, previews
and confirmations should use saved access without visible windows.

Each implemented provider needs observed routes, account binding where applicable,
bounded requests, synthetic tests and an honest entry in VERIFICATION.md. Writes
need exact previews and single-use confirmation; uncertain writes must not be
automatically retried. Do not perform real purchases, bookings or print jobs merely
as smoke tests. Public research sources and dates belong in documentation; account
data, browser captures and session state stay in ignored local storage.
