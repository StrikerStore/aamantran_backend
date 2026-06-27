# Couple Planning API

The couple planning APIs are mounted under:

```text
/api/user/events/:id
```

They are implemented by `src/routes/userEvents.js` and
`src/controllers/planning.controller.js`, with models in `prisma/schema.prisma`.
The router applies `verifyUserJWT` to every route, so callers must authenticate
with a couple dashboard JWT. Each controller verifies that `:id` belongs to
`req.user.id`; an inaccessible event returns `404`.

Responses generally use `{ "ok": true, ... }` on success and
`{ "ok": false, "message": "..." }` on validation or ownership failures.

## Endpoint summary

| Area | Method and path | Required fields | Response key |
| --- | --- | --- | --- |
| Tasks | `GET /:id/tasks` | none | `tasks` |
| Tasks | `POST /:id/tasks` | `title` | `task` |
| Tasks | `PATCH /:id/tasks/:tid` | any task field | `task` |
| Tasks | `DELETE /:id/tasks/:tid` | none | none |
| Inventory | `GET /:id/inventory` | none | `items` |
| Inventory | `POST /:id/inventory` | `name` | `item` |
| Inventory | `PATCH /:id/inventory/:iid` | any inventory field | `item` |
| Inventory | `DELETE /:id/inventory/:iid` | none | none |
| Budget | `GET /:id/budget` | none | `budget` |
| Budget | `PUT /:id/budget` | `totalBudget` | `budget` |
| Expenses | `GET /:id/budget/expenses` | none | `expenses` |
| Expenses | `POST /:id/budget/expenses` | `description`, `amount` | `expense` |
| Expenses | `PATCH /:id/budget/expenses/:xid` | any expense field | `expense` |
| Expenses | `DELETE /:id/budget/expenses/:xid` | none | none |
| Vendors | `GET /:id/vendors` | none | `vendors` |
| Vendors | `POST /:id/vendors` | `name` | `vendor` |
| Vendors | `PATCH /:id/vendors/:vid` | any vendor field | `vendor` |
| Vendors | `DELETE /:id/vendors/:vid` | none | none |
| Timeline | `GET /:id/timeline` | none | `entries` |
| Timeline | `POST /:id/timeline` | `time`, `title` | `entry` |
| Timeline | `PATCH /:id/timeline/:eid` | any timeline field | `entry` |
| Timeline | `DELETE /:id/timeline/:eid` | none | none |
| Mood board | `GET /:id/moodboard` | none | `pins` |
| Mood board | `POST /:id/moodboard` | file or `imageUrl` | `pin` |
| Mood board | `DELETE /:id/moodboard/:mid` | none | none |
| Pinterest | `GET /:id/pinterest-oembed?url=...` | Pinterest URL | oEmbed fields |
| Gifts | `GET /:id/gifts` | none | `gifts` |
| Gifts | `POST /:id/gifts` | `fromName` | `gift` |
| Gifts | `PATCH /:id/gifts/:gid` | any gift field | `gift` |
| Gifts | `DELETE /:id/gifts/:gid` | none | none |
| Photo wall | `GET /:id/photos` | none | `photos` |
| Photo wall | `POST /:id/photos` | `file` | `photo` |
| Photo wall | `DELETE /:id/photos/:pid` | none | none |

The implementation updates child rows directly by child id after the event owner
check. Keep route access behind the owner check when extending this controller.

## Field defaults and value conventions

The schema stores these values as strings, not Prisma enums. Treat the values
below as API conventions shared with the frontend.

### Tasks

Create body:

```json
{
  "title": "Book photographer",
  "category": "Photography",
  "dueDate": "2026-11-01",
  "priority": "high",
  "assignedTo": "bride",
  "status": "todo",
  "notes": "Shortlist vendors first"
}
```

Defaults and conventions:

- `category`: defaults to `Other`
- `dueDate`: string, commonly `YYYY-MM-DD`
- `priority`: `low`, `medium`, `high`; defaults to `medium`
- `assignedTo`: free-form, commonly `bride`, `groom`, `family`, `vendor`
- `status`: `todo`, `inprogress`, `done`; defaults to `todo`

### Inventory

Create body:

```json
{
  "name": "Welcome gifts",
  "category": "Decor",
  "subCategory": "Guest",
  "quantity": 150,
  "unit": "pcs",
  "status": "to-buy",
  "estimatedCost": 12000
}
```

Defaults and conventions:

- `category`: defaults to `Other`
- `quantity`: parsed as integer, defaults to `1`
- `unit`: defaults to `pcs`
- `status`: `to-buy`, `ordered`, `received`, `packed`, `at-venue`, `done`
- `estimatedCost` and `actualCost`: parsed as decimal numbers
- `reminderDate`: string, commonly `YYYY-MM-DD`

### Budget and expenses

Budget total:

```json
{
  "totalBudget": 500000
}
```

Expense body:

```json
{
  "description": "Venue advance",
  "category": "Venue",
  "vendor": "City Palace",
  "amount": 75000,
  "paid": true,
  "dueDate": "2026-10-10",
  "notes": "Receipt uploaded elsewhere"
}
```

`GET /:id/budget` returns `{ "totalBudget": 0 }` when no budget row exists yet.
Amounts are decimal numbers, unlike payment amounts which are stored in paise.

### Vendors

Create body:

```json
{
  "name": "Lens Studio",
  "type": "Photography",
  "contactName": "Asha",
  "phone": "9876543210",
  "email": "asha@example.com",
  "website": "https://example.com",
  "packageName": "Two-day coverage",
  "packageCost": 120000,
  "depositPaid": 25000,
  "totalPaid": 25000,
  "status": "contacted",
  "bookingDate": "2026-09-15"
}
```

Defaults and conventions:

- `type`: defaults to `Other`; examples include `Photography`, `Catering`,
  `Decor`, `Music`, `Attire`, `Priest`, `Transport`, `Makeup`, `Mehendi`
- `status`: `contacted`, `negotiating`, `booked`, `deposit-paid`,
  `fully-paid`, `cancelled`
- cost fields are parsed as decimal numbers

### Timeline

Create body:

```json
{
  "functionId": "function-uuid",
  "time": "10:30 AM",
  "title": "Haldi ceremony",
  "location": "Lawn",
  "responsiblePerson": "Coordinator",
  "duration": "45 mins",
  "sortOrder": 10
}
```

`functionId` is optional and links the entry to a ceremony/function. Timeline
lists are ordered by `sortOrder` ascending.

### Mood board

`POST /:id/moodboard` accepts either JSON with an `imageUrl` or
`multipart/form-data` with a `file` field:

```text
file=<image file>
caption=Stage inspiration
category=Decor
```

When R2 is enabled, uploaded files are stored under
`moodboard/{eventId}/{uuid}.{ext}` and returned as public R2 URLs. In local mode,
the URL is `/uploads/{filename}`.

`GET /:id/pinterest-oembed?url=...` accepts only HTTPS Pinterest hosts
(`pin.it`, `pinterest.com`, `www.pinterest.com`, or subdomains). If Pinterest
cannot return embeddable HTML, the API still returns `ok: true` with
`embedUnavailable: true`.

### Gifts

Create body:

```json
{
  "fromName": "Rohan",
  "fromRelation": "Friend",
  "giftDescription": "Dinner set",
  "receivedDate": "2026-12-01",
  "estimatedValue": 5000,
  "thankYouSent": false
}
```

`fromName` is required. `estimatedValue` is parsed as a decimal number and
`thankYouSent` is converted with JavaScript `Boolean(...)`.

### Photo wall

`POST /:id/photos` requires `multipart/form-data` with a `file` field:

```text
file=<image or video file>
caption=Reception entry
category=Reception
```

When R2 is enabled, files are stored under
`photowall/{eventId}/{uuid}.{ext}`. In local mode, the URL is
`/uploads/{filename}`. `category` defaults to `Ceremony`.

## Upload constraints

`src/middleware/uploadUserMedia.js` allows these extensions for planning media:

- images: `.jpg`, `.jpeg`, `.png`, `.gif`, `.svg`, `.webp`, `.avif`, `.bmp`
- audio: `.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.flac`
- video: `.mp4`, `.webm`, `.mov`

Maximum upload size is 50 MB. The multipart field name must be `file`.
