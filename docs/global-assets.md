# Global background-music library

Shared audio the admin uploads once. Couples and Template Lab
developers pick a URL from the list; they do not own the bytes. The
same URL can sit on many `Media` rows, which is why event-scoped
cleanup must never delete a library object.

Handlers: `src/controllers/globalAssets.controller.js`.
Router: `src/routes/globalAssets.js` (mounted twice).
Lab read: `listAssets` in `src/controllers/devLab.controller.js`.

## Surfaces

| Who | Mount | Auth |
| --- | --- | --- |
| Admin write | `POST /api/v1/assets`, `DELETE /api/v1/assets/:id` | Admin JWT (`issuer: aamantran:admin`) |
| Anyone list | `GET /api/v1/assets` and `GET /api/assets` | None |
| Lab list | `GET /api/dev/assets` | Dev JWT (`issuer: aamantran:dev`) |

`GET` is unauthenticated on both `/api/v1/assets` and `/api/assets`
because they share one router and `auth` is only on POST/DELETE. Treat
everything in this table as public. Do not store private files here.

## Data model

`GlobalAsset`: `id` (UUID), `type` (free text, e.g. `bg_music`),
`name`, `url` (up to 2048), `createdAt`. Newest first on every list.

`type` is **not** validated. Create always writes the object under
`assets/music/{uuid}{ext}` regardless of the string you send.

## List

```
GET /api/assets
GET /api/v1/assets
GET /api/v1/assets?limit=20&page=1
```

Without a positive `limit`, the handler returns every row -- the
original contract, so the public picker and any existing caller keep
working:

```
{ "ok": true, "assets": [ { "id", "type", "name", "url", "createdAt" }, ... ] }
```

`limit` that is finite and `> 0` switches on pagination (capped at
**100**) and adds `total`, `page`, `limit`. That is what the admin
panel uses after the 2026-08-20 loading-speed change. `page` defaults
to 1. `limit=0` or a non-numeric value is treated as "no pagination".

Lab `GET /api/dev/assets` always returns the full list, no
`createdAt`, no pagination.

## Create (admin)

`POST /api/v1/assets` -- multipart field `file` plus body `type` and
`name`. Any missing -> **400** `Missing file, type, or name`.

```
curl -X POST "$API/api/v1/assets" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -F "type=bg_music" \
  -F "name=Sitar evening" \
  -F "file=@sitar.mp3"
```

Constraints (same multer as template ZIP uploads,
`src/middleware/upload.js`):

- Max **50 MB**
- Audio extensions allowed: `.mp3` `.wav` `.ogg` `.m4a` `.aac` `.flac`
- Missing extension on the original filename becomes `.mp3`

Storage key: `assets/music/{uuid}{ext}`.

| Mode | Object | Public URL |
| --- | --- | --- |
| R2 (all `R2_*` set) | `putObject` | `{R2_PUBLIC_BASE_URL}/{key}` |
| Local disk | `uploads/{key}` | `{req.protocol}://{host}/uploads/{key}` |

Response is **200** `{ ok: true, asset }` (not 201). The temp multer
file is unlinked after the copy.

## Delete (admin)

`DELETE /api/v1/assets/:id` -- **404** `Not found` if the row is gone.

The row is deleted first, then object cleanup is best-effort:

- R2: first `assets/music/[^/]+$` match on the stored URL, then
  `deleteObjectKey`. A URL that does not match that pattern leaves the
  object in the bucket.
- Local: path after `/uploads/`, `unlink` errors swallowed.

A 200 here means the **row** is gone. Bytes may still exist if the
URL shape was unexpected.

## Attaching a track to an event

The couple (or admin-as-user) does **not** copy the file. They POST
the library URL onto a `Media` row:

```
POST /api/user/events/:id/media
{ "url": "https://media.example/assets/music/....mp3", "slotKey": "background_music" }
```

`addEventMedia` (`src/services/eventMedia.service.js`) accepts a URL
when the slot's `allowUrl` is not `false` (the default). The URL is
stored verbatim.

Renderer music pick (`src/services/templateRenderer.js`): first
`Media` of `type === 'music'`, else `slotKey === 'background_music'`,
else `slotKey === 'music'`. That becomes `{{music_url}}`.

## Why shared deletes are guarded

Two independent guards stop "remove my background music" from wiping
the library for everyone:

1. `deleteOwnedMediaObject` only deletes keys under
   `uploads/events/{eventId}/` or
   `users/{ownerId}/whatsapp-share-images/`. A library URL matches
   neither.
2. `objectStorage.tryDeletePublicUrl` no-ops when the key starts with
   `assets/` (`isSharedObjectKey`).

Account deletion and test-account purge use (2). Replacing a
single-file slot uses (1).

The admin `DELETE /api/v1/assets/:id` path calls `deleteObjectKey`
directly and **does** remove the bytes. Every event still pointing at
that URL then 404s the file. Clear or re-point those `Media` rows
before deleting a popular track.

## Template Lab

`GET /api/dev/assets` is the same table, developer-scoped only by the
dev JWT (no per-developer filter -- the library is global).

A developer attaches a track with:

- `POST /api/dev/templates/:id/activate` `{ musicUrl }`
- `PUT /api/dev/sandbox` `{ musicUrl }`

`currentMusicUrl` is read back before reseed / preset apply so a
schema save does not silently drop the chosen track. `musicUrl: ""`
or `null` on `putSandbox` deletes that event's music rows only -- not
the `GlobalAsset`.

## Pitfalls

- `GET /api/assets` is public and unpaginated by default. A large
  library will dump every row to any caller that omits `limit`. The
  admin UI must pass `limit`.
- Do not delete a `GlobalAsset` while live invites still reference
  its URL. Event media delete will not save you; only the admin
  asset delete removes the object.
- `type` is free text and list does not filter on it. The upload
  prefix is always `assets/music/`.
- Lab list has no pagination and no `createdAt`. Do not assume it
  matches the admin payload.
- Local-disk URLs are minted from `req.protocol` + `Host`. Trust
  proxy is on unless `TRUST_PROXY=0`. Turning it off behind a reverse
  proxy mints `http://` library URLs that the browser then blocks.
- Creating an asset does not attach it to any event. The picker is a
  separate write.
