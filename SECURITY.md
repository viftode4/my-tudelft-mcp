# Security and privacy reports

Never publish credentials, session state, student records, coursework, live target files or browser traces in an issue or pull request.

If GitHub private vulnerability reporting is enabled for this repository, use the **Security** tab's private reporting option. Otherwise, open a minimal issue asking how to contact the maintainer privately, without vulnerability details or private data. This document does not establish an email address or another reporting channel.

Useful initial information includes the affected component, sanitized description, impact and a synthetic reproduction. Remove account identifiers, tokens, signed URLs, course/submission IDs, local usernames and paths. Do not send passwords or MFA codes.

For accidental disclosure, stop sharing the material, revoke or rotate affected credentials through the relevant service, and arrange removal with the maintainer. Deleting a file in a later commit does not remove earlier copies from history.

The connector handles authenticated university data locally. Its boundaries include exact account/resource verification, confined credential destinations, bounded extraction, explicit previews and no automatic retry of uncertain writes. Tests cannot establish universal compatibility or replace review of a proposed change.
