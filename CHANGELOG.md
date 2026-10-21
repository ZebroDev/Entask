**English** · [繁體中文](CHANGELOG.zh-TW.md)
# Changelog

All notable changes to Entask are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] - 2026-10-21

### Fixed

- The frontend test suite no longer assumes which whitespace character sits between the date
  and the day period in the team report drill-down assertions; ICU versions differ there
  (U+2009 vs. U+0020), which is what made the 1.0.3 CI run fail. No user-visible change.

## [1.0.3] - 2026-10-21

### Added

- Team performance report explainability: each member's grade now comes with a breakdown of the
  completion tier, the on-time and first-pass-yield S-gate checks (thresholds and sample counts
  included), and any review-score adjustment with the average score it was based on.
- Drill-down from a member's completion, on-time, first-pass-yield and average-score figures to
  the exact cards or review entries behind them; rows the viewer may not read are counted
  separately instead of being removed silently.
- Deadline changes are recorded with their previous and new dates and appear in the on-time
  drill-down. History starts with this release; earlier changes have no previous value.

### Fixed

- The team report uses the full content width, the member action moved to the first column, and
  clickable figures now carry a visible affordance.
- The user management and system activity pages use the same page shell as the rest of the app.
- Printing a member dossier produces one page: the dialog no longer repeats on every printed
  page, and the app chrome, close button and avatar are left off the paper.

### Notes

- No database migrations or configuration changes.

## [1.0.2] - 2026-10-16

### Fixed

- Security: the bundled HTTP client `axios` was updated to 1.20.0, resolving 12 advisories
  (7 high) in the production dependency tree; the build/test-only dependencies `undici`,
  `vitest`, `brace-expansion` and `source-map-js` were updated to their patched versions.
- The CI workflow now declares explicit least-privilege `permissions` (`contents: read`),
  resolving three code-scanning findings. No user-visible change.

## [1.0.1] - 2026-10-16

### Fixed

- The frontend test suite no longer assumes which whitespace character sits between the date
  and the day period in Traditional Chinese date-time output; ICU versions differ there
  (U+2009 vs. U+0020), which is what made the 1.0.0 CI run fail. No user-visible change.

## [1.0.0] - 2026-10-16

Initial open-source release, licensed under the GNU Affero General Public License
version 3.0 only (AGPL-3.0-only).

### Added

- Kanban boards with drag-and-drop, list/card ordering, and per-project members; on touch
  screens a long press starts a drag, and a list's grip handle drags immediately
- Mind map view per project
- Card worklogs (estimated vs. actual hours), personal worklog page, and team worklog
- Project reports: status, workload, ratings, and worklog reports with selectable time windows
- Calendar and Gantt views, plus a bulk-editable table view
- Card review lifecycle: request review, approve, request changes, remove reviewer, with a
  confirmation step before a review is submitted
- Custom fields, tags, checklists, comments, attachments, global search, and notifications
- Role-based access control with project-scoped permissions
- Admin-only system activity log covering user lifecycle events; resetting a password also
  unlocks the account
- Cursor pagination ("load more") on card activity, comments, and the system activity log
- Hardened deployment defaults: containers run as a non-root user, health checks, security
  headers and a content security policy, and reverse-proxy forwarded-header support
- Six locales, including English and Traditional Chinese
- One-click self-hosting with Docker Compose; Fly.io deployment files included
- AGPL section 13 source offer on the login page and in the user menu

[1.0.4]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.4
[1.0.3]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.3
[1.0.2]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.2
[1.0.1]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.1
[1.0.0]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.0
