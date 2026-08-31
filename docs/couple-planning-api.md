# Couple planning API

The couple dashboard exposes planning tools under the authenticated
`/api/user/events/:id/*` route group. These endpoints are for event owners only.

## Codepaths

| Concern | Source |
| --- | --- |
| Route definitions | `src/routes/userEvents.js` |
| Planning handlers | `src/controllers/planning.controller.js` |
| User JWT middleware | `src/middleware/userAuth.js` |
| Upload middleware | `src/middleware/uploadUserMedia.js` |
| Planning models | `prisma/schema.prisma` |

## Authentication and ownership

All routes in `src/routes/userEvents.js` require a bearer token verified with JWT
issuer `aamantran:user` and `role: "user"`.

Each planning handler loads the event by `:id` and checks that
`event.ownerId === req.user.id`. When the event is missing or belongs to another
user, handlers return `404` with `{ ok: false, message: "Event not found" }`.

## Route summary

| Resource | Routes |
| --- | --- |
| Tasks | `GET/POST /:id/tasks`, `PATCH/DELETE /:id/tasks/:tid` |
| Inventory | `GET/POST /:id/inventory`, `PATCH/DELETE /:id/inventory/:iid` |
| Budget total | `GET/PUT /:id/budget` |
| Budget expenses | `GET/POST /:id/budget/expenses`, `PATCH/DELETE /:id/budget/expenses/:xid` |
| Vendors | `GET/POST /:id/vendors`, `PATCH/DELETE /:id/vendors/:vid` |
| Timeline | `GET/POST /:id/timeline`, `PATCH/DELETE /:id/timeline/:eid` |
| Mood board | `GET/POST /:id/moodboard`, `DELETE /:id/moodboard/:mid` |
| Pinterest oEmbed | `GET /:id/pinterest-oembed?url=...` |
| Gifts | `GET/POST /:id/gifts`, `PATCH/DELETE /:id/gifts/:gid` |
| Photo wall | `GET/POST /:id/photos`, `DELETE /:id/photos/:pid` |

List responses use resource-specific keys such as `tasks`, `items`, `expenses`,
`vendors`, `entries`, `pins`, `gifts`, and `photos`. Create responses return
`201` with `{ ok: true, <resource>: ... }`; update/delete responses return
`{ ok: true, ... }`.

## Request shapes

### Tasks

`POST /api/user/events/:id/tasks`

Required: `title`.

Optional fields and defaults:

```json
{
  "title": "Book photographer",
  "category": "Photography",
  "dueDate": "2026-11-10",
  "priority": "medium",
  "assignedTo": "family",
  "status": "todo",
  "notes": "Shortlist vendors"
}
```

Status values are not enum-enforced by the API, but the schema comments document
`todo`, `inprogress`, and `done`. Priority defaults to `medium`.

### Inventory

`POST /api/user/events/:id/inventory`

Required: `name`.

```json
{
  "name": "Welcome hampers",
  "category": "Decor",
  "subCategory": "Guest gifts",
  "quantity": 100,
  "unit": "pcs",
  "status": "to-buy",
  "location": "Home",
  "assignedTo": "groom",
  "vendor": "Local supplier",
  "estimatedCost": 25000,
  "actualCost": 0,
  "reminderDate": "2026-11-01",
  "reminderNote": "Confirm delivery",
  "notes": "Use gold packaging"
}
```

Quantities are parsed as integers. Costs are parsed as decimals.

### Budget

`PUT /api/user/events/:id/budget`

Required: `totalBudget`.

```json
{ "totalBudget": 1500000 }
```

`GET /api/user/events/:id/budget` returns an existing budget row or
`{ totalBudget: 0 }` when no row exists yet.

### Budget expenses

`POST /api/user/events/:id/budget/expenses`

Required: `description`, `amount`.

```json
{
  "description": "Venue advance",
  "category": "Venue",
  "vendor": "Palace Banquet",
  "amount": 500000,
  "paid": true,
  "dueDate": "2026-10-01",
  "notes": "Receipt uploaded outside this API"
}
```

### Vendors

`POST /api/user/events/:id/vendors`

Required: `name`.

```json
{
  "name": "Golden Lens",
  "type": "Photography",
  "contactName": "Asha",
  "phone": "9876543210",
  "email": "asha@example.com",
  "website": "https://example.com",
  "packageName": "Full wedding",
  "packageCost": 250000,
  "depositPaid": 50000,
  "totalPaid": 50000,
  "status": "contacted",
  "bookingDate": "2026-09-20",
  "notes": "Ask for drone add-on"
}
```

### Timeline

`POST /api/user/events/:id/timeline`

Required: `time`, `title`.

```json
{
  "functionId": "optional-function-id",
  "time": "10:30 AM",
  "title": "Haldi entrance",
  "location": "Lawn",
  "responsiblePerson": "bride_brother",
  "duration": "30 mins",
  "notes": "Cue music",
  "sortOrder": 10
}
```

Timeline lists are sorted by `sortOrder`.

### Mood board

`POST /api/user/events/:id/moodboard`

Accepts either JSON with an image URL:

```json
{
  "imageUrl": "https://example.com/inspiration.jpg",
  "caption": "Mandap flowers",
  "category": "Decor"
}
```

or `multipart/form-data` with a single `file`, plus optional `caption` and
`category`.

When R2 is enabled, uploaded files are stored under
`moodboard/{eventId}/{uuid}.{ext}` and returned as public R2 URLs. Otherwise the
API returns `/uploads/{filename}`.

`GET /api/user/events/:id/pinterest-oembed?url=...` accepts only HTTPS Pinterest
or `pin.it` URLs. It returns:

```json
{
  "ok": true,
  "html": "<iframe ...></iframe>",
  "title": "Board title",
  "boardUrl": "https://www.pinterest.com/...",
  "embedUnavailable": false
}
```

If Pinterest does not provide embeddable HTML, the route still returns `ok: true`
with `embedUnavailable: true`.

### Gifts

`POST /api/user/events/:id/gifts`

Required: `fromName`.

```json
{
  "fromName": "Mehta Family",
  "fromRelation": "uncle",
  "giftDescription": "Silver dinner set",
  "receivedDate": "2026-11-18",
  "estimatedValue": 12000,
  "thankYouSent": false,
  "notes": "Send thank-you after wedding"
}
```

### Photo wall

`POST /api/user/events/:id/photos`

Requires `multipart/form-data` with a single `file`; optional fields are
`caption` and `category` (default `Ceremony`).

When R2 is enabled, uploaded files are stored under
`photowall/{eventId}/{uuid}.{ext}`. Otherwise the API returns `/uploads/{filename}`.

## Upload constraints

The shared couple upload middleware allows one `file` up to 50 MB with these
extensions:

```text
.jpg .jpeg .png .gif .svg .webp .avif .bmp
.mp3 .wav .ogg .m4a .aac .flac
.mp4 .webm .mov
```

Only mood board and photo wall planning endpoints use uploads in this controller.

## Pitfalls

- Update/delete handlers check event ownership first, but item IDs are not scoped
  again in the Prisma update/delete call. Always call these routes with IDs that
  belong to the event currently open in the dashboard.
- Date fields are stored as strings, not `DateTime`, for planning resources.
- Numeric fields are parsed with `parseFloat` or `parseInt`; send numbers or
  numeric strings.
- Boolean fields such as `paid` and `thankYouSent` use JavaScript `Boolean(...)`;
  avoid sending the string `"false"` from forms because it is truthy.
