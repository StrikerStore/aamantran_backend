# Support tickets and public contact

Logged-in couples open and reply on support tickets. Admins work the
same thread from the admin app. A separate public `POST /api/contact`
form is for people who are not (yet) customers.

Ticket HTML lives in `src/services/internalEmailTemplates.js`. Senders
live in `src/services/email.service.js`. There is no stored ticket
number: the human ref is derived from the UUID.

## Surfaces

| Who | Mount | Auth |
| --- | --- | --- |
| Couple | `/api/user/tickets` | User JWT (`issuer: aamantran:user`) |
| Admin | `/api/v1/tickets` | Admin JWT (`issuer: aamantran:admin`) |
| Anyone | `POST /api/contact` | None; `checkoutLimiter` |

Couple handlers: `src/controllers/userDashboard.controller.js`.
Admin handlers: `src/controllers/tickets.controller.js`.
Contact: `src/routes/contact.js`.

## Data model

`SupportTicket`: `id` (UUID), `userId`, optional `eventId`, `subject`,
`status` (`open` | `resolved`), timestamps.

`TicketMessage`: `senderRole` (`user` | `admin`), `body` (text),
`createdAt`. Cascade-deleted with the ticket.

Human reference (emails and phone, not a column):

```
AT- + first 8 hex chars of the UUID, uppercased
```

`ticketReference('a1b2c3d4-e5f6-...')` => `AT-A1B2C3D4`. Search admin
by that prefix of the id.

## Couple API

All routes require a user token. Someone else's ticket is
indistinguishable from a missing one (**404** `Ticket not found`) so
an id cannot be probed.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/user/tickets` | That user's tickets, newest first, each with full `messages` |
| POST | `/api/user/tickets` | `{ subject, message, eventId? }` -- 201 |
| GET | `/api/user/tickets/:id` | Full ticket + messages |
| GET | `/api/user/tickets/:id/messages` | Cheap poll; see below |
| POST | `/api/user/tickets/:id/reply` | `{ message }` or `{ body }`; 201 |

`POST /` requires `subject` and `message`. Optional `eventId` must
belong to the caller (else 403 `Event not found`). The first message
is created as `senderRole: 'user'`.

`POST /:id/reply` trims the body, rejects empty, rejects over **5000**
characters. Always sets `status` to `open` and bumps `updatedAt`.

A reply on a **resolved** ticket reopens it and returns
`reopened: true`. Accepting the message and leaving `resolved` would
drop it: nobody works a queue of resolved tickets.

```
{ "ok": true, "message": { ... }, "status": "open", "reopened": true }
```

Profile email cannot be changed in-app. A filled phone is write-once.
Those handlers tell the couple to raise a ticket
(`src/controllers/userDashboard.controller.js` profile + frozen names).

## Admin API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/tickets` | `?status=&page=&limit=` (default page 1, limit 20) |
| GET | `/api/v1/tickets/:id` | User (incl. phone), event, all messages |
| GET | `/api/v1/tickets/:id/messages` | Cheap poll; see below |
| POST | `/api/v1/tickets/:id/reply` | `{ body }` required |
| PATCH | `/api/v1/tickets/:id/resolve` | `status: resolved` |
| PATCH | `/api/v1/tickets/:id/reopen` | `status: open` |

List is ordered by `updatedAt` desc so a customer reply rises. Test
accounts are hidden via `EXCLUDE_TEST_OWNER`.

Admin reply does **not** change `status`. A reply on a resolved ticket
stays resolved; only the couple's reply reopens. `updatedAt` is bumped
so the row still moves in the list.

Admin `get` / `reply` use `findUniqueOrThrow`. A bad id is a 500
through the global error handler, not a 404.

Admin reply has no 5000-character cap (couple reply does).

## Message polling

Open threads poll every few seconds. A separate route exists so a
`?since=` flag on `GET :id` cannot quietly change that response shape
for older callers.

```
GET /api/user/tickets/:id/messages?since=<ISO>
GET /api/v1/tickets/:id/messages?since=<ISO>
```

Response: `{ ok, messages, status }`. `status` rides along so a badge
can flip when the other side resolves (or the couple reopens) without
re-fetching the ticket.

`since` is a `createdAt > that instant` filter. Absent or unparseable
`since` returns the whole thread (degrades to a plain refresh, not an
error).

Couple poll still 404s another user's id. Admin poll 500s a missing
id (`findUniqueOrThrow`).

## Mail

SMTP must be set (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`; port defaults
to 587). `EMAIL_FROM` falls back to `SMTP_USER`, then
`aamantran@plexzuu.com`.

| Event | Team | Customer |
| --- | --- | --- |
| Ticket opened | `[Ticket AT-........] {subject}` | `We received your request - AT-........` |
| Couple replies | `[Ticket AT-........] Customer replied - {subject}` | none |
| Admin replies | none | `Re: {subject}` with dashboard link |

Team mail uses `sendInternalMail`:

```
INTERNAL_NOTIFY_TO || CONTACT_FORM_TO || ADMIN_EMAIL
```

If none are set, the alert is skipped with a warning. Internal send
never throws.

Couple create/reply fire mail **after** the row is saved
(`.catch` + `console.error`). An SMTP outage must not turn a
successful submit into a retry that duplicates the ticket.

Admin reply awaits `sendTicketReplyEmail` with `.catch`, so the HTTP
response still succeeds if mail fails. The customer link is
`{COUPLE_DASHBOARD_URL}/support/{ticketId}`.

Admin-to-customer HTML interpolates `replyBody` with only newline-to-
`<br/>` -- it is **not** escaped. Keep admin replies as plain text.

Team templates HTML-escape the couple's text. Deep link:
`{ADMIN_URL}/tickets/{ticketId}`.

## Public contact form

`POST /api/contact` is not a ticket. It emails the team and returns.
Recipient is `CONTACT_FORM_TO || ADMIN_EMAIL` only --
`INTERNAL_NOTIFY_TO` does not move this inbox.

Required, validated server-side in form order (the page used to ship
`noValidate` and skipped phone):

1. `name` -- non-empty
2. `phone` + `phoneCountryCode` -- `normalizePhone` (same helper as
   checkout and onboarding)
3. `email` -- non-empty and `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`
4. `message` -- non-empty

`eventType` and `eventDate` are optional. First failure is **400**
`{ ok: false, message }` with that helper's reason string.

Phone rules (`src/utils/phone.js`):

- Default dial code `+91` if the picker is empty.
- A leading `+` or `00` on the number is treated as international;
  the typed code wins if it disagrees with the picker.
- Without that marker, the picker is trusted and only a leading trunk
  `0` is stripped. Guessing would delete a real leading `1` on a `+1`
  number.
- E.164 length 8-15 digits (country code included).
- `+91` still requires a 10-digit mobile starting 6-9.

The email shows `formatPhone` (`+91 9876543210`) so the team can
WhatsApp it. `<>` are stripped from interpolated fields. SMTP failure
or a missing recipient is **500** to the browser (unlike ticket mail).

## Pitfalls

- There is no `ticketNumber` column. Do not add one without also
  changing `ticketReference` callers.
- Couple reply field is `message` *or* `body`. Admin reply is `body`
  only.
- Couple reply reopens; admin reply does not. Resolve from admin when
  the thread is actually done.
- Couple list embeds every message. Use `GET :id/messages` for polling,
  not `GET :id` / `GET /`.
- Contact form 500s on mail failure; ticket create does not.
- Contact ignores `INTERNAL_NOTIFY_TO`.
- Admin `GET/POST :id` on a missing ticket is 500, not 404.
- Do not change a couple's email or a filled phone from the profile
  API; send them here.
