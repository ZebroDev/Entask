**English** · [繁體中文](CHANGELOG.zh-TW.md)
# Changelog

All notable changes to Entask are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/ZebroDev/Entask/releases/tag/v1.0.0
