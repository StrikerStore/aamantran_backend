const prisma = require('../utils/prisma');

/**
 * GET /coupons — optionally paginated.
 *
 * Without a `limit` param this behaves exactly as before and returns every
 * coupon, so existing callers are unaffected. Passing `limit` (capped at 100)
 * switches on pagination and adds `total`.
 */
async function list(req, res) {
  const rawLimit = Number(req.query.limit);
  const paginated = Number.isFinite(rawLimit) && rawLimit > 0;
  const limit = paginated ? Math.min(rawLimit, 100) : undefined;
  const page = Math.max(1, Number(req.query.page) || 1);

  const [coupons, total] = await Promise.all([
    prisma.couponCode.findMany({
      orderBy: { createdAt: 'desc' },
      ...(paginated ? { skip: (page - 1) * limit, take: limit } : {}),
    }),
    paginated ? prisma.couponCode.count() : Promise.resolve(undefined),
  ]);

  res.json({ ok: true, data: coupons, ...(paginated ? { total, page, limit } : {}) });
}

async function create(req, res) {
  const { code, discountPercent, expiresAt, maxGlobalUses, maxUsesPerUser, minOrderAmount, isActive = true, isDisplayed = false } = req.body || {};
  const normalized = String(code || '').trim().toUpperCase();
  const pct = Number(discountPercent);

  if (!normalized) {
    return res.status(400).json({ ok: false, message: 'Coupon code is required' });
  }
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    return res.status(400).json({ ok: false, message: 'Discount percent must be between 1 and 100' });
  }

  const parsedExpiry = expiresAt ? new Date(expiresAt) : null;
  if (parsedExpiry && Number.isNaN(parsedExpiry.getTime())) {
    return res.status(400).json({ ok: false, message: 'Invalid expiry date' });
  }
  const globalLimit = maxGlobalUses === '' || maxGlobalUses === null || maxGlobalUses === undefined ? null : Number(maxGlobalUses);
  const perUserLimit = maxUsesPerUser === '' || maxUsesPerUser === null || maxUsesPerUser === undefined ? null : Number(maxUsesPerUser);
  const minAmountRupees = minOrderAmount === '' || minOrderAmount === null || minOrderAmount === undefined ? 0 : Number(minOrderAmount);
  if (globalLimit !== null && (!Number.isFinite(globalLimit) || globalLimit < 1)) {
    return res.status(400).json({ ok: false, message: 'Global usage limit must be at least 1' });
  }
  if (perUserLimit !== null && (!Number.isFinite(perUserLimit) || perUserLimit < 1)) {
    return res.status(400).json({ ok: false, message: 'Per-user usage limit must be at least 1' });
  }
  if (!Number.isFinite(minAmountRupees) || minAmountRupees < 0) {
    return res.status(400).json({ ok: false, message: 'Minimum order amount cannot be negative' });
  }

  const coupon = await prisma.couponCode.create({
    data: {
      code: normalized,
      discountPercent: Math.round(pct),
      expiresAt: parsedExpiry,
      maxGlobalUses: globalLimit === null ? null : Math.round(globalLimit),
      maxUsesPerUser: perUserLimit === null ? null : Math.round(perUserLimit),
      minOrderAmount: Math.round(minAmountRupees * 100),
      isActive: Boolean(isActive),
      // Advertising a coupon that does not work would be worse than not
      // advertising it, so display always implies active.
      isDisplayed: Boolean(isDisplayed) && Boolean(isActive),
    },
  });

  res.status(201).json({ ok: true, data: coupon });
}

async function update(req, res) {
  const { discountPercent, expiresAt, maxGlobalUses, maxUsesPerUser, minOrderAmount, isActive, isDisplayed } = req.body || {};
  const data = {};
  if (discountPercent !== undefined) {
    const pct = Number(discountPercent);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return res.status(400).json({ ok: false, message: 'Discount percent must be between 1 and 100' });
    }
    data.discountPercent = Math.round(pct);
  }
  if (isActive !== undefined) {
    data.isActive = Boolean(isActive);
    // Disabling a coupon also unpublishes it: a live offer strip must never
    // advertise a code that the apply step will refuse.
    if (!data.isActive) data.isDisplayed = false;
  }
  if (isDisplayed !== undefined) {
    const wantDisplayed = Boolean(isDisplayed);
    if (wantDisplayed) {
      // The coupon must end this request active. It may be being activated in
      // the same call; otherwise fall back to what is stored, so display cannot
      // be switched on for a coupon that is already disabled.
      const willBeActive = data.isActive !== undefined
        ? data.isActive
        : (await prisma.couponCode.findUnique({
            where:  { id: req.params.id },
            select: { isActive: true },
          }))?.isActive;
      if (!willBeActive) {
        return res.status(400).json({ ok: false, message: 'A disabled coupon cannot be shown on checkout' });
      }
    }
    data.isDisplayed = wantDisplayed;
  }
  if (expiresAt !== undefined) {
    if (!expiresAt) data.expiresAt = null;
    else {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ ok: false, message: 'Invalid expiry date' });
      }
      data.expiresAt = parsed;
    }
  }
  if (maxGlobalUses !== undefined) {
    if (maxGlobalUses === '' || maxGlobalUses === null) data.maxGlobalUses = null;
    else {
      const n = Number(maxGlobalUses);
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({ ok: false, message: 'Global usage limit must be at least 1' });
      }
      data.maxGlobalUses = Math.round(n);
    }
  }
  if (maxUsesPerUser !== undefined) {
    if (maxUsesPerUser === '' || maxUsesPerUser === null) data.maxUsesPerUser = null;
    else {
      const n = Number(maxUsesPerUser);
      if (!Number.isFinite(n) || n < 1) {
        return res.status(400).json({ ok: false, message: 'Per-user usage limit must be at least 1' });
      }
      data.maxUsesPerUser = Math.round(n);
    }
  }
  if (minOrderAmount !== undefined) {
    if (minOrderAmount === '' || minOrderAmount === null) data.minOrderAmount = 0;
    else {
      const n = Number(minOrderAmount);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ ok: false, message: 'Minimum order amount cannot be negative' });
      }
      data.minOrderAmount = Math.round(n * 100);
    }
  }

  const coupon = await prisma.couponCode.update({
    where: { id: req.params.id },
    data,
  });
  res.json({ ok: true, data: coupon });
}

async function remove(req, res) {
  await prisma.couponCode.delete({ where: { id: req.params.id } });
  res.json({ ok: true, message: 'Coupon deleted' });
}

module.exports = { list, create, update, remove };
