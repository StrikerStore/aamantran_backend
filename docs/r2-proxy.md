# R2 asset proxy

`GET /r2-proxy/<object key>` re-serves a private-bucket object from the API
origin. Template HTML is rendered by this process (`/i/:slug`, `/demo/:slug`,
`/try/:token`). The JS and CSS it references live in R2. Loading those from
the media host is cross-origin, and R2 does not echo
`Access-Control-Allow-Origin`, so the browser blocks them.

Code: `src/routes/r2Proxy.js`, mounted in `src/routes/index.js` before the
other routers. No auth.

## When it is on

The handler returns 404 `Not found` unless `useObjectStorage()` is true
(`src/config/storage.js`). That requires all five of `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and
`R2_PUBLIC_BASE_URL`. `npm run check:env` treats the public base as advised,
not required (`docs/check-env.md`). Four keys without the base still look
healthy to a quick reading of that report, and this route stays dark. Local
disk serves templates from `/s` instead, and `readTemplateHtml` does not
rewrite URLs.

## URL and key

```
GET /r2-proxy/templates/<folder>/assets/app.js
R2 key: templates/<folder>/assets/app.js
```

The wildcard is `decodeURIComponent`'d and leading slashes are stripped. An
empty key is 400 `Bad request`. A missing object (`NoSuchKey`, `NotFound`, or
HTTP 404 from the SDK) is 404 `Not found`. Any other storage error is passed
to the global error handler.

There is no prefix allowlist. Any key the caller can name is readable if the
bucket holds it. Do not put secrets in this bucket.

Content-Type comes from the file extension (`contentTypeForPath`). An unknown
extension is `application/octet-stream`.

## Two rewrites

Upload time (`rewriteAssetPaths` in `src/services/fileManager.js`) rewrites
relative paths inside the ZIP to the public base, for example
`https://media.aamantran.online/templates/<folder>/...`, or to `/s/<folder>/`
on local disk.

Read time, only when object storage is on:

1. `readTemplateHtml` runs `rewriteR2AssetsToProxy` on the entry HTML. Every
   occurrence of `R2_PUBLIC_BASE_URL` (no trailing slash) becomes
   `{API_BASE_URL}/r2-proxy`.
2. When the browser then fetches CSS or JS through this route,
   `rewriteAssetOriginsInBody` does the same replacement inside the body.
   The content type must match `text/css` or `application/javascript`. Images,
   fonts, and everything else are passed through. That second pass is what
   keeps a `url()` in CSS, or a string in a JS bundle, on the API origin.

`API_BASE_URL` is `siteUrls.apiBaseUrl()` (env, or
`https://api.aamantran.online` in production). A wrong base here makes every
asset URL point at the wrong host. The match is an exact string split/join,
so a trailing slash on `R2_PUBLIC_BASE_URL` is stripped before the comparison,
and a different host in an old object is not rewritten.

No cache-busting query string is added. Freshness is the response headers:

```
Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate
Pragma: no-cache
Expires: 0
Surrogate-Control: no-store
```

The same key (`templates/<folder>/assets/index.js`) is overwritten when an
admin uploads a new ZIP. `immutable` or a long `max-age` would pin the old
bundle. Invite HTML uses the same no-store set (`setNoCacheHeaders`).

The route also sets `Access-Control-Allow-Origin: *` and
`Cross-Origin-Resource-Policy: cross-origin`.

## What still runs first

The comment on the mount says the proxy is first so CSP and CORS never apply.
Helmet and the CORS allowlist are mounted in `src/app.js` before `app.use('/', routes)`,
so they run for this path too.

Invite pages are served from the API origin, and rewritten asset URLs are on
that same origin, so the browser does not make a CORS request for them.
`'self'` in the page CSP already allows that. A browser on some other origin
still has to pass the app CORS check before this handler runs. The `cors`
package answers preflight itself, so the proxy's own `OPTIONS /*` handler
usually does not.

CSP on a stylesheet or script response does not decide whether the invite
page may load it. The page's CSP does. Helmet still attaches a policy to the
asset response because it is global.
