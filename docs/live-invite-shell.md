# Live invite HTML shell

Published invitations are HTML assembled in `renderTemplate`
(`src/services/templateRenderer.js`), then sent by `GET /i/:slug`
(`src/routes/render.js`). The same compiler also serves `/demo/:slug`,
`/try/:token`, and `GET /i/:slug/preview`. Favicon injection runs for all
four. The guest SDK is only attached on the live invite.

## Compile

Handlebars is compiled with `{ noEscape: true }`. A value in the data object
is written into the page exactly as given: text, an attribute, or a string
inside an inline script. The template is trusted host content. Visitor-typed
trial fields are a different path: `inertText` in
`src/services/trialDemo.service.js` strips angle brackets, straight double
quotes, backticks, backslashes, and braces, and turns an apostrophe into a
typographic one before those values ever reach this compiler. Guest wishes
never go through Handlebars. See below.

Order inside `renderTemplate`:

1. Read the entry HTML. On object storage, CDN URLs in that file are rewritten
   to `/r2-proxy` first (`docs/r2-proxy.md`).
2. `injectFavicon`.
3. `injectSocialMeta`, only when the caller passed `socialMeta`.
4. `injectAamantranRuntime`, only when the caller passed `aamantranContext`.

`/demo/:slug` stops after the favicon, then `injectDemoBuyBar` appends the
buy button. `/try/:token` does the same and then replaces share tags itself.
`/i/:slug/preview` stops after the favicon: no share card, no SDK.

## Favicon

Templates rarely ship a tab icon. Without a `<link rel="icon">`, the browser
asks this origin for `/favicon.ico` and used to 404.

`injectFavicon` inserts only:

```html
<link rel="icon" href="/favicon.ico" type="image/x-icon" sizes="any">
<link rel="shortcut icon" href="/favicon.ico" type="image/x-icon">
```

`public/favicon.svg` is not linked. Browsers prefer an SVG icon whenever one
is declared, whatever the link order, so an SVG tag here would always win.
The SVG file is still in `public/` if a template links to it.

Skip rule: if the HTML already matches

`<link` ... `rel=` ... word `icon`

the function returns the HTML unchanged. It does not add a second icon, and
it does not replace the template's. `rel="icon"`, `rel="shortcut icon"`, and
`rel="apple-touch-icon"` all match (`icon` is a whole word at the end of
`apple-touch-icon`). The test is a regex, not an HTML parse.

Placement: immediately before `</head>` (the search is case-insensitive; the
bytes are not rewritten). If there is no close tag, immediately after the
opening `<head>`. If there is no head, the two links are prepended. Putting
them at the end of head keeps the template's charset meta first.

The files are served by a static mount in `src/app.js` on `public/`,
`maxAge: 7d`, `index: false`, `redirect: false`. It is mounted even when
templates live on R2, because these icons ship with the process. The invite
HTML itself is `Cache-Control: no-store`. The icon file is the thing cached
for seven days. Replacing `public/favicon.ico` does not show up for a browser
that already cached it.

`GET /favicon.ico` still works when injection was skipped. The link tags only
stop the tab from looking unbranded.

## Share tags

Only `GET /i/:slug` passes `socialMeta` into `renderTemplate`. Tags are
`og:type`, `og:site_name`, `og:title`, `og:description`, `og:url`, `og:image`,
`og:image:alt` (only when there is an image), and the matching `twitter:*`
card. A key that is already present is left alone. The existing-tag check is
quote-terminated, so `og:image` does not count as `og:image:alt`.

Values go through `escapeAttr` (`&`, `<`, `>`, `"`). Empty values are omitted.
Title, description, URL, and image are chosen in the `/i/:slug` handler:
person 1 then person 2, the first function's date in `Asia/Kolkata`, and
`pickShareImage` (`wa_share_image`, then a photo in `invite_hero`,
`couple_images`, `gallery`, `photos`, `grand_entry`, then any photo).

`/try/:token` calls `injectSocialMeta` again after `stripShareMeta`, with a
fixed title and no image, so a forwarded demo does not preview the couple's
names.

## Guest wishes are plain text

`POST /api/public/wishes` (`src/routes/publicInvite.js`) stores `guestName`
and `message` with `sanitizeText`. That helper:

- strips other control characters, keeping tab, newline, and carriage return
- trims
- cuts the name at 120 characters and the message at 500

It does not encode `<`, `>`, quotes, or `&`. An earlier version escaped on
write. The wish wall then showed the entities as text (`&#x27;` on the page),
because the reader also escaped. Encoding belongs to the renderer.

The public wall is `GET /api/public/wishes/:eventSlug`. It returns
`{ guestName, message }` JSON for rows with `isApproved: true`. New wishes
are created with `isApproved: true`. The couple hides one with
`PATCH /api/user/events/:id/wishes/:wishId/visibility` and `{ "visible": false }`,
which sets `isApproved` to false. The dashboard list returns the stored
strings, including hidden rows.

The invite page does not interpolate those strings into HTML. The SDK
(`src/services/aamantranSdk.js`, served at `GET /sdk/aamantran-sdk.js`)
builds each row with `document.createElement` and assigns `textContent`.
`textContent` is the escape. A message that contains `<script>` shows up as
text.

Do not "fix" this by HTML-encoding the column. Do not render `message` with
`innerHTML` or by concatenating it into a template string. `guestNotesEnabled
=== false` makes the GET return an empty list and the POST return 403.
Wishes for an invite pair are stored on the `inviteScope: 'full'` row
(`resolveWishOwnerEventId`). RSVP rows stay on the invite that was submitted.

The SDK is injected only when `aamantranContext` is set, which today is only
`GET /i/:slug`. `/try/:token` does not load it: an RSVP or wish typed into a
personal demo is not submitted. Context is `JSON.stringify`'d into
`window.__AAMANTRAN__` and the script tag is placed before `</body>`.

`guestNotesEnabled` and `rsvpEnabled` default to on when the column is null
(`!== false`). The wish form posts `{ eventSlug, guestName, message }`. The
SDK refuses an empty trimmed name or message before the request. The server
requires the raw fields to be present, then rejects an empty message after
`sanitizeText`. A name that is only whitespace is stored as an empty string.
There is no auth. A rejected body still counts toward the in-process wish
limit below.

Limits, stacked:

| Limit | Where | What |
| --- | --- | --- |
| 200 requests / 15 min per IP, unless `RATE_LIMIT_PUBLIC_INVITE_MAX` | `publicInviteLimiter` on all of `/api/public` | 429 `{ "message": "Too many requests..." }` |
| 5 wishes / 10 min per IP | in-process `Map` in `publicInvite.js`, key `wish:<ip>` | 429 `Too many wish submissions...` |
| 5 RSVPs / 10 min per IP | same map, key `rsvp:<ip>` | separate bucket from wishes |

The map is per process and is dropped on restart. IP is the first
`X-Forwarded-For` hop. `trust proxy` is 1 unless `TRUST_PROXY=0`.
