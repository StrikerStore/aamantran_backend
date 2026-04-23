const express = require('express');
const auth    = require('../middleware/auth');
const prisma  = require('../utils/prisma');

const router = express.Router();
router.use(auth);

const REVIEW_SELECT = {
  id: true, rating: true, reviewText: true,
  coupleNames: true, location: true, couplePhotoUrl: true,
  isHidden: true, isAdminCreated: true, createdAt: true,
  template: { select: { id: true, name: true, slug: true } },
  user:     { select: { id: true, username: true, email: true } },
};

// GET /api/v1/reviews — list all reviews, optionally filtered
router.get('/', async (req, res) => {
  try {
    const { templateId, hidden, page = 1, limit = 50 } = req.query;
    const where = {
      ...(templateId && { templateId }),
      ...(hidden === 'true'  && { isHidden: true  }),
      ...(hidden === 'false' && { isHidden: false }),
    };
    const [reviews, total] = await Promise.all([
      prisma.templateReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
        select: REVIEW_SELECT,
      }),
      prisma.templateReview.count({ where }),
    ]);
    res.json({ reviews, total });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/v1/reviews — admin creates a review
router.post('/', async (req, res) => {
  try {
    const { templateId, rating, reviewText, coupleNames, location, couplePhotoUrl } = req.body || {};
    if (!templateId) return res.status(400).json({ message: 'templateId is required' });
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ message: 'rating must be 1–5' });

    const template = await prisma.template.findUnique({ where: { id: templateId }, select: { id: true } });
    if (!template) return res.status(404).json({ message: 'Template not found' });

    const review = await prisma.templateReview.create({
      data: {
        templateId,
        rating: Number(rating),
        reviewText: reviewText || null,
        coupleNames: coupleNames || null,
        location: location || null,
        couplePhotoUrl: couplePhotoUrl || null,
        isAdminCreated: true,
      },
      select: REVIEW_SELECT,
    });

    await recalcAvgRating(templateId);
    res.status(201).json(review);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/v1/reviews/:id/hide
router.patch('/:id/hide', async (req, res) => {
  try {
    const review = await prisma.templateReview.update({
      where: { id: req.params.id },
      data:  { isHidden: true },
      select: REVIEW_SELECT,
    });
    await recalcAvgRating(review.template.id);
    res.json(review);
  } catch {
    res.status(404).json({ message: 'Review not found' });
  }
});

// PATCH /api/v1/reviews/:id/show
router.patch('/:id/show', async (req, res) => {
  try {
    const review = await prisma.templateReview.update({
      where: { id: req.params.id },
      data:  { isHidden: false },
      select: REVIEW_SELECT,
    });
    await recalcAvgRating(review.template.id);
    res.json(review);
  } catch {
    res.status(404).json({ message: 'Review not found' });
  }
});

// DELETE /api/v1/reviews/:id
router.delete('/:id', async (req, res) => {
  try {
    const review = await prisma.templateReview.findUnique({
      where: { id: req.params.id },
      select: { templateId: true },
    });
    if (!review) return res.status(404).json({ message: 'Review not found' });
    await prisma.templateReview.delete({ where: { id: req.params.id } });
    await recalcAvgRating(review.templateId);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ message: 'Review not found' });
  }
});

async function recalcAvgRating(templateId) {
  const agg = await prisma.templateReview.aggregate({
    where: { templateId, isHidden: false },
    _avg:  { rating: true },
  });
  await prisma.template.update({
    where: { id: templateId },
    data:  { avgRating: agg._avg.rating || 0 },
  });
}

module.exports = router;
