const prisma = require('../utils/prisma');
const slugify = require('../utils/slugify');
const storage = require('../config/storage');
const objectStorage = require('../services/objectStorage');
const path = require('path');
const fs = require('fs');

// ── helpers ──────────────────────────────────────────────────────────

/** Upload cover image to R2 (or local uploads/) and return the public URL. */
async function uploadCoverImage(file, slug) {
  const ext = path.extname(file.originalname || '.jpg').toLowerCase();
  const key = `blog/${slug}/cover${ext}`;

  if (storage.useObjectStorage()) {
    const buf = fs.readFileSync(file.path);
    const contentType = storage.contentTypeForPath(file.originalname);
    await objectStorage.putObject(key, buf, contentType);
    fs.unlinkSync(file.path); // clean up temp file
    return `${storage.objectStoragePublicBase()}/${key}`;
  }
  // Local fallback — file is already in ./uploads/ via multer
  return `/uploads/${path.basename(file.path)}`;
}

/** Delete cover image from R2 if it's an R2 URL. */
async function deleteCoverImage(url) {
  if (!url) return;
  await objectStorage.tryDeletePublicUrl(url);
}

/** Generate a unique slug, appending a random suffix if collision exists. */
async function generateUniqueSlug(title, excludeId) {
  let base = slugify(title);
  if (!base) base = 'post';

  // Check if slug is taken
  const where = { slug: base, ...(excludeId ? { NOT: { id: excludeId } } : {}) };
  const existing = await prisma.blogPost.findFirst({ where });
  if (!existing) return base;

  // Append random suffix
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

// ── Admin handlers ───────────────────────────────────────────────────

/** GET /api/v1/blog — List all posts (admin, paginated, filterable by status) */
async function list(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const status = req.query.status; // 'draft' | 'published' | undefined (all)

  const where = status ? { status } : {};
  const [posts, total] = await Promise.all([
    prisma.blogPost.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.blogPost.count({ where }),
  ]);

  res.json({ posts, total, page, limit });
}

/** GET /api/v1/blog/:id — Get single post by ID (admin) */
async function get(req, res) {
  const post = await prisma.blogPost.findUnique({ where: { id: req.params.id } });
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found' });
  res.json(post);
}

/** POST /api/v1/blog — Create new post (admin, multipart) */
async function create(req, res) {
  const { title, excerpt, content, metaTitle, metaDescription, tags, author, slug: customSlug } = req.body;

  if (!title || !content) {
    return res.status(400).json({ ok: false, message: 'Title and content are required' });
  }

  const slug = customSlug?.trim()
    ? slugify(customSlug.trim())
    : await generateUniqueSlug(title);

  // Check slug uniqueness
  const existing = await prisma.blogPost.findUnique({ where: { slug } });
  if (existing) {
    return res.status(409).json({ ok: false, message: `Slug "${slug}" already exists` });
  }

  let coverImageUrl = null;
  if (req.file) {
    coverImageUrl = await uploadCoverImage(req.file, slug);
  }

  const post = await prisma.blogPost.create({
    data: {
      slug,
      title: title.trim(),
      excerpt: excerpt?.trim() || null,
      coverImageUrl,
      content,
      metaTitle: metaTitle?.trim() || null,
      metaDescription: metaDescription?.trim() || null,
      tags: tags?.trim() || null,
      author: author?.trim() || 'Aamantran Team',
    },
  });

  res.status(201).json(post);
}

/** PUT /api/v1/blog/:id — Update post (admin, multipart) */
async function update(req, res) {
  const post = await prisma.blogPost.findUnique({ where: { id: req.params.id } });
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found' });

  const { title, excerpt, content, metaTitle, metaDescription, tags, author, slug: customSlug } = req.body;

  // Handle slug update
  let newSlug = post.slug;
  if (customSlug?.trim() && slugify(customSlug.trim()) !== post.slug) {
    newSlug = slugify(customSlug.trim());
    const conflict = await prisma.blogPost.findFirst({
      where: { slug: newSlug, NOT: { id: post.id } },
    });
    if (conflict) {
      return res.status(409).json({ ok: false, message: `Slug "${newSlug}" already exists` });
    }
  }

  // Handle cover image update
  let coverImageUrl = post.coverImageUrl;
  if (req.file) {
    // Delete old cover from R2
    await deleteCoverImage(post.coverImageUrl);
    coverImageUrl = await uploadCoverImage(req.file, newSlug);
  }

  const updated = await prisma.blogPost.update({
    where: { id: post.id },
    data: {
      slug: newSlug,
      ...(title !== undefined ? { title: title.trim() } : {}),
      ...(excerpt !== undefined ? { excerpt: excerpt.trim() || null } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(metaTitle !== undefined ? { metaTitle: metaTitle.trim() || null } : {}),
      ...(metaDescription !== undefined ? { metaDescription: metaDescription.trim() || null } : {}),
      ...(tags !== undefined ? { tags: tags.trim() || null } : {}),
      ...(author !== undefined ? { author: author.trim() || 'Aamantran Team' } : {}),
      coverImageUrl,
    },
  });

  res.json(updated);
}

/** PATCH /api/v1/blog/:id/publish — Publish post */
async function publish(req, res) {
  const post = await prisma.blogPost.findUnique({ where: { id: req.params.id } });
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found' });

  const updated = await prisma.blogPost.update({
    where: { id: post.id },
    data: {
      status: 'published',
      publishedAt: post.publishedAt || new Date(),
    },
  });

  res.json(updated);
}

/** PATCH /api/v1/blog/:id/unpublish — Revert to draft */
async function unpublish(req, res) {
  const post = await prisma.blogPost.findUnique({ where: { id: req.params.id } });
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found' });

  const updated = await prisma.blogPost.update({
    where: { id: post.id },
    data: { status: 'draft' },
  });

  res.json(updated);
}

/** DELETE /api/v1/blog/:id — Delete post + cover image */
async function remove(req, res) {
  const post = await prisma.blogPost.findUnique({ where: { id: req.params.id } });
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found' });

  // Delete cover image from R2
  await deleteCoverImage(post.coverImageUrl);

  // Also delete the whole blog/{slug}/ prefix in R2 (in case of future multi-image support)
  if (storage.useObjectStorage()) {
    await objectStorage.deleteByPrefix(`blog/${post.slug}/`);
  }

  await prisma.blogPost.delete({ where: { id: post.id } });
  res.json({ ok: true });
}

// ── Public handlers ──────────────────────────────────────────────────

/** GET /api/blog — List published posts (public, paginated) */
async function listPublished(req, res) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const tag = req.query.tag?.trim();

  const where = {
    status: 'published',
    ...(tag ? { tags: { contains: tag } } : {}),
  };

  const [posts, total] = await Promise.all([
    prisma.blogPost.findMany({
      where,
      orderBy: { publishedAt: 'desc' },
      skip,
      take: limit,
      select: {
        id: true,
        slug: true,
        title: true,
        excerpt: true,
        coverImageUrl: true,
        tags: true,
        author: true,
        publishedAt: true,
      },
    }),
    prisma.blogPost.count({ where }),
  ]);

  res.json({ posts, total, page, limit });
}

/** GET /api/blog/:slug — Get single published post by slug (public) */
async function getPublished(req, res) {
  const post = await prisma.blogPost.findFirst({
    where: { slug: req.params.slug, status: 'published' },
  });
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found' });
  res.json(post);
}

module.exports = {
  list,
  get,
  create,
  update,
  publish,
  unpublish,
  remove,
  listPublished,
  getPublished,
};
