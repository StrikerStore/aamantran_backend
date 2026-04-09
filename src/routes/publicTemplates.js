// Public-facing API used by the landing page (no auth required)
const express = require('express');
const prisma  = require('../utils/prisma');
const { publicInviteLimiter } = require('../middleware/rateLimits');

const router = express.Router();
router.use(publicInviteLimiter);

// GET /api/templates — template listing for the gallery page
// Query params: community, eventType, exclude, limit, sort, page
router.get('/', async (req, res) => {
  const { community, eventType, exclude, limit = 20, sort = 'popular', page = 1 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const where = {
    isActive: true,
    ...(community  && { community }),
    ...(eventType  && { bestFor: { contains: eventType } }),
    ...(exclude    && { slug: { not: exclude } }),
  };

  const orderBy =
    sort === 'popular'    ? { buyerCount: 'desc' } :
    sort === 'new'        ? { releasedAt: 'desc' } :
    sort === 'price-asc'  ? { price: 'asc'  } :
    sort === 'price-desc' ? { price: 'desc' } :
    { buyerCount: 'desc' };

  const [templates, total] = await Promise.all([
    prisma.template.findMany({
      where,
      skip,
      take:    Number(limit),
      orderBy,
      select: {
        id: true, slug: true, name: true,
        thumbnailUrl: true, desktopThumbnailUrl: true, mobileThumbnailUrl: true, community: true,
        desktopEntryFile: true, mobileEntryFile: true,
        bestFor: true, languages: true,
        price: true, originalPrice: true, gstPercent: true,
        buyerCount: true, avgRating: true, releasedAt: true,
      },
    }),
    prisma.template.count({ where }),
  ]);

  res.json({ templates, total, page: Number(page), limit: Number(limit) });
});

// GET /api/reviews/featured — must be before /:slug to avoid slug capture
// (mounted at /api/reviews in index.js → resolves to /api/reviews/featured)
router.get('/featured', async (req, res) => {
  const { limit = 6 } = req.query;
  const reviews = await prisma.templateReview.findMany({
    where:   { reviewText: { not: null } },
    take:    Number(limit),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, rating: true, reviewText: true,
      coupleNames: true, location: true, createdAt: true,
    },
  });
  res.json(reviews);
});

// GET /api/templates/:slug — single template detail for product page
router.get('/:slug', async (req, res) => {
  const template = await prisma.template.findUnique({
    where: { slug: req.params.slug, isActive: true },
    select: {
      id: true, slug: true, name: true,
      thumbnailUrl: true, desktopThumbnailUrl: true, mobileThumbnailUrl: true, community: true,
      desktopEntryFile: true, mobileEntryFile: true,
      bestFor: true, languages: true, style: true, colourPalette: true, animations: true,
      price: true, originalPrice: true, gstPercent: true, aboutText: true,
      buyerCount: true, avgRating: true, releasedAt: true,
    },
  });

  if (!template) return res.status(404).json({ message: 'Template not found' });

  const reviewCount = await prisma.templateReview.count({ where: { templateId: template.id } });
  res.json({ ...template, reviewCount });
});

// GET /api/templates/:slug/reviews
router.get('/:slug/reviews', async (req, res) => {
  const { limit = 6 } = req.query;
  const template = await prisma.template.findUnique({ where: { slug: req.params.slug } });
  if (!template) return res.json([]);

  const reviews = await prisma.templateReview.findMany({
    where:   { templateId: template.id },
    take:    Number(limit),
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, rating: true, reviewText: true,
      coupleNames: true, location: true, createdAt: true,
    },
  });
  res.json(reviews);
});

module.exports = router;
