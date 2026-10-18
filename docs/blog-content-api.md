# Blog content API

The blog subsystem provides admin-managed marketing posts and a public read API
for the landing site. Posts are stored in MySQL through Prisma and optional cover
images are stored either in Cloudflare R2 or on local disk, depending on the
storage environment.

## Architecture

- `src/routes/index.js` mounts admin routes at `/api/v1/blog` and public routes
  at `/api/blog`.
- `src/routes/blog.js` protects all admin endpoints with the admin JWT
  middleware and accepts `coverImage` multipart uploads for create/update.
- `src/routes/publicBlog.js` exposes only published posts and does not require
  authentication.
- `src/controllers/blog.controller.js` owns slug generation, status transitions,
  cover upload/deletion, pagination, and public filtering.
- `prisma/schema.prisma` defines `BlogPost`; migration
  `20260704120000_add_blog_post` creates the table and indexes
  `(status, publishedAt)` for public reads.

## Data model

`BlogPost` fields:

| Field | Notes |
| --- | --- |
| `id` | UUID primary key. |
| `slug` | Unique URL slug. Generated from the title unless a custom slug is supplied. |
| `title` | Required on create. |
| `excerpt` | Optional text summary. |
| `coverImageUrl` | Optional public URL for the uploaded cover image. |
| `content` | Required Markdown content stored as `LongText`. |
| `metaTitle`, `metaDescription` | Optional SEO overrides. |
| `tags` | Optional comma-separated string, for example `wedding, invitations`. |
| `author` | Defaults to `Aamantran Team`. |
| `status` | `draft` by default; public APIs only return `published`. |
| `publishedAt` | Set the first time a post is published; not cleared on unpublish. |

## Admin workflow

1. Obtain an admin token with `POST /api/v1/auth/login`.
2. Create or update a post using JSON fields plus an optional multipart
   `coverImage` file.
3. Publish the post with `PATCH /api/v1/blog/:id/publish`.
4. Revert it to draft with `PATCH /api/v1/blog/:id/unpublish` if it should no
   longer appear publicly.

Admin requests must include:

```http
Authorization: Bearer <admin-jwt>
```

The token is issued by `/api/v1/auth/login` with issuer `aamantran:admin` and
`role: "admin"`.

## Endpoint reference

### Admin endpoints

| Method and path | Behavior |
| --- | --- |
| `GET /api/v1/blog?page=1&limit=20&status=draft` | Lists posts. `limit` is clamped to 1-50. `status` is optional and passed through as an exact filter. |
| `GET /api/v1/blog/:id` | Returns one post by UUID, or `404` when missing. |
| `POST /api/v1/blog` | Creates a post. Requires `title` and `content`; accepts optional `coverImage`. |
| `PUT /api/v1/blog/:id` | Updates supplied fields and optionally replaces the cover image. |
| `PATCH /api/v1/blog/:id/publish` | Sets `status` to `published` and sets `publishedAt` if empty. |
| `PATCH /api/v1/blog/:id/unpublish` | Sets `status` to `draft`; leaves `publishedAt` unchanged. |
| `DELETE /api/v1/blog/:id` | Deletes the DB row and attempts to delete R2 cover objects. |

Create example:

```bash
curl -X POST "$API_BASE_URL/api/v1/blog" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -F "title=Wedding Invitation Wording Guide" \
  -F "excerpt=Examples for families and couples" \
  -F "content=# Wedding Invitation Wording\n\nMarkdown body..." \
  -F "tags=wedding, invitations, wording" \
  -F "author=Aamantran Team" \
  -F "coverImage=@./cover.webp"
```

Publish example:

```bash
curl -X PATCH "$API_BASE_URL/api/v1/blog/$POST_ID/publish" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Public endpoints

| Method and path | Behavior |
| --- | --- |
| `GET /api/blog?page=1&limit=20&tag=wedding` | Lists published posts ordered by `publishedAt desc`. `limit` is clamped to 1-50. |
| `GET /api/blog/:slug` | Returns one published post by slug, or `404` when missing or still draft. |

Public list responses intentionally omit the full `content` body and return:
`id`, `slug`, `title`, `excerpt`, `coverImageUrl`, `tags`, `author`, and
`publishedAt`.

## Slug behavior

- Slugs are normalized to lowercase ASCII, spaces/underscores become hyphens,
  non-alphanumeric characters are removed, duplicate hyphens collapse, and
  leading/trailing hyphens are stripped.
- Empty generated slugs fall back to `post`.
- When no custom slug is supplied, a title collision gets a random suffix such
  as `post-a1b2c`.
- When a custom slug conflicts with an existing post, create/update returns
  `409`.
- Updating `title` does not regenerate the slug; send the `slug` field
  explicitly when a URL change is intended.

## Cover image storage

Uploads use the shared `src/middleware/upload.js` Multer configuration:

- Form field name: `coverImage`.
- Maximum file size: 50 MB.
- Allowed extensions include common image formats (`.jpg`, `.jpeg`, `.png`,
  `.gif`, `.svg`, `.webp`, `.avif`, `.bmp`, `.ico`) plus other template asset
  types accepted by the shared uploader.

Storage mode:

- R2 mode is enabled only when all of `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, and `R2_PUBLIC_BASE_URL` are set.
- In R2 mode, covers are uploaded to `blog/{slug}/cover{ext}` and the API stores
  `${R2_PUBLIC_BASE_URL}/blog/{slug}/cover{ext}`.
- Without full R2 configuration, files remain under local `./uploads` and the API
  stores `/uploads/{generated-file-name}`.

Operational constraints:

- Replacing a cover deletes the previous R2 object when the old URL belongs to
  the configured public R2 base.
- Deleting a post removes the DB row, deletes the R2 cover URL when possible, and
  deletes the R2 prefix `blog/{slug}/`. Local `/uploads` files are not cleaned up
  by the blog delete path.
- If a post slug changes after a cover was uploaded, the existing cover URL is
  not moved unless a new `coverImage` is uploaded with the update.

## Troubleshooting

- `401 No token provided` or `Invalid or expired token`: log in through
  `/api/v1/auth/login` and send `Authorization: Bearer <token>`.
- `403 Forbidden`: the JWT is valid but does not have `role: "admin"`.
- `400 Title and content are required`: create requests must include both fields.
- `400 File type ... not allowed`: the shared upload allowlist rejected the file
  extension.
- `409 Slug "..." already exists`: choose a different custom slug or omit the
  slug so the controller can generate a unique one from the title.
- Public endpoint returns `404`: the slug may be wrong, or the post is still in
  `draft`.
- Public list tag filters use substring matching on the comma-separated `tags`
  string. Keep tag naming consistent to avoid accidental matches.
