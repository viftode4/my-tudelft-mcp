# Contributing

Use synthetic fixtures and bounded changes. Account ownership, explicit action previews and honest coverage are part of this personal student connector's behavior.

## Local development

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run build
```

Read the [README](README.md) for optional live checks. Automated tests must not require university credentials, downloaded coursework or a private account.

Explain the problem, resulting behavior, checks run and remaining compatibility limits. Add regression tests that establish meaningful behavior or boundaries. Prefer documented APIs and observed learner routes; do not guess IDs or widen authenticated destinations merely to make a test pass.

## Public-source privacy

Inspect staged files and diffs before sharing. Never add:

- Session vaults, cookies, OAuth/LTI payloads, browser profiles or environment secrets.
- Course downloads, assignment work, grades, feedback, peer details or screenshots.
- Real account/course/group/submission targets, live reports, traces or network bodies.
- Personal filesystem paths, machine usernames or private contact details.

Keep runtime data in ignored `.local/`. Use invented IDs, names and content in fixtures. Public university documentation URLs are suitable references; personal authenticated URLs and signed links are not.

Do not force-add ignored runtime data. Build source archives from reviewed tracked files, not a copy of the working directory.

## Reporting behavior

Include the tool name, a sanitized error code, expected behavior, runtime versions and synthetic reproduction steps. Do not attach raw student-account responses or logs. If private data is essential, arrange a private channel using [SECURITY.md](SECURITY.md) first.

Do not perform real enrollments, group changes, submissions or email actions merely to test a pull request. Obtain the affected user's explicit approval for an exact live action; a course page or fixture cannot supply it.
