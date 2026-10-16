**English** · [繁體中文](features.zh-TW.md)
## Recent features

### Full CRUD for checklist items
- **Backend**: new route `DELETE /api/cards/{cardId}/checklists/{checklistId}/items/{itemId}`
- **Frontend**:
  - Item deletion (shared confirmation dialog)
  - Click the text to rename (Enter submits / Escape cancels / blur saves)
  - Move up / move down buttons (reordered with base62 `between`, stepping over the neighbour)

### Calendar view "+N more" entry point
- **Frontend**:
  - From the fourth card on the same day, hidden cards are listed via `@radix-ui/react-popover`
  - Clicking a card opens `CardDialog`
  - Semantic colours preserved (completion line, overdue red)

### Board duplication second confirmation
- Duplication now goes through an AlertDialog stating that lists, cards, labels and custom-field
  values are copied along, and that the copy must be deleted by hand

### Custom-field editing
- Create and edit are separate; editing opens a per-row dialog whose title carries the field name
- Type changes warn about the consequence inside the dialog (existing values will be cleared); the
  button becomes "Change and clear values"
- Dropdown options now use chip input: Enter or a half-width / full-width comma adds an option;
  pasting "High,Medium,Low" splits it in one go, trimming and de-duplicating

### Mind map shows bound-card completion state
- Canvas nodes and outline rows both mark completion (green tick / strikethrough / completed
  badge), without opening the card
- SVG / PNG export renders the same

### Unified table styling
- Five table containers unified to the Card frame with `bg-muted/50` headers; TableTab's row
  density is a deliberate functional choice and stays as it is

### Worklogs (daily / weekly / monthly)
- Three entry points — personal (`/my-worklog`), project page, team page — sharing one
  daily/weekly/monthly toggle and the `WorkLogReport` component
- Local-day grouping happens in the backend: the front end sends local-day `yyyy-MM-dd` `from` /
  `to` (`to` exclusive), the backend groups by the local day frozen at write time, and the
  returned `Workdays` list is the front end's only source of workdays
- Holiday determination is centralised in `WorkCalendar.IsWorkday`; all three endpoints have
  `/export` sibling routes (SpreadsheetML `.xls`)
- The "unreported workdays (total)" KPI card opens a detail dialog of the missing days

### Card reviewer assignment
- CardDialog reviewer menu: assign / unassign, one-click "assign to me", the assignable-member
  list, and the reviewer badge count

### Start date and true Gantt span
- `Card.StartAt` and a start-date picker in CardDialog; the Gantt chart draws the true span from
  startAt, and falls back to a single-day marker at the due date (no more fabricated days)

### Comments get their own tab, with cursor pagination
- Comments move out of the activity tab into `CardCommentsTab` (infinite scroll); activity always
  uses the `GET /api/cards/{cardId}/activity` cursor pagination
- New `card.comment` permission code: roles without `card.edit` (such as test engineers) can
  comment; the comment routes accept `card.comment` or `card.edit`

### PWA and mobile
- `manifest.json` defines the scope so the home-screen app on phones launches without the Safari
  navigation bar
- `index.html` / `manifest.json` are served `no-store` and the remaining static assets `immutable`,
  fixing the phone home-screen app being stuck on an old version
- Login credentials live in localStorage, so the PWA does not ask you to log in again each time it
  opens

### Touch drag on the board
- Touch activation is press-and-hold (250 ms) with a 5 px tolerance rather than a distance
  threshold: a distance threshold is satisfied *before* the browser commits to a scroll, so the
  drag started, the overlay mounted, and a `pointercancel` ended it about 30 ms later — the card
  lifted, flashed and vanished, while the scroll happened anyway
- The list grip handle is exempt from the delay: it carries `touch-action: none`, so it never
  competes with scrolling and can drag immediately. Holding still for 250 ms is also what starts
  the browser's long-press text selection, which made a 16 px handle awkward to grab
- The handle's hit area is 40×48 (was 16×16); while the drag is held the column lifts
  (`shadow-xl ring-2 ring-primary/20`) and the handle lights up

### Review submission gate
- Submitting a review asks for confirmation first, and the score is chosen from a dropdown instead
  of typed as free text

### System activity log (admin only)
- User lifecycle events have their own admin-only page; audit rows carry the actor's display name

### Load-more pagination
- Card activity, comments and the system activity log page with a cursor instead of returning
  everything at once

### Deployment hardening
- Containers run as a non-root user and carry health checks; the API sends baseline security
  headers and a content security policy, and honours reverse-proxy forwarded headers when
  configured to trust one
