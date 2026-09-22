/**
 * Marketing insights and try-it demo analytics for the admin Analytics tab.
 *
 * /summary says how much traffic came; this says what to do about it: which
 * channels and campaigns sell, which designs draw interest but do not convert,
 * when people shop, where the funnel leaks, and whether "Try it with your names"
 * earns its place. Findings are written out as plain sentences (`insights`) so a
 * campaign can be planned from the page without reading every table.
 *
 * Sources, and what each can and cannot say:
 *   - WebsiteSession / WebsiteEvent: anonymous first-party analytics, kept 90
 *     days. Tracked purchases undercount (ad blockers, closed tabs), so they are
 *     used for RATES between channels, never as the sales figure.
 *   - Payment: the authoritative order count and revenue, grouped by currency.
 *   - TrialDemo: demos are erased 24 hours after creation, so the table only
 *     ever describes the last day. History comes from the website events, and
 *     sales from Payment.fromTrialDemo, which outlives the demo.
 *
 * Nothing here returns what a visitor typed into a demo — no names, venue,
 * city or date. Live demos are listed by design, age and view count only.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { EXCLUDE_TEST_OWNER, EXCLUDE_SANDBOX_TEMPLATE } = require('../utils/testFilters');
const { parseRange, parseStorefront, sessionStorefrontWhere } = require('./websiteAnalytics.controller');
const { LINK_MINUTES, DATA_HOURS, DAILY_CAP } = require('../services/trialDemo.service');

/** India Standard Time, for the "when do people shop" heatmap. */
const IST_OFFSET_MIN = 330;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Below these, a rate is noise and no insight is drawn from it. */
const MIN_CHANNEL_VISITORS = 20;
const MIN_TEMPLATE_VIEWERS = 15;
const MIN_TRY_SESSIONS = 5;

/** Keep in sync with aamantran_website/lib/trialDemo.ts LeadBucket. */
const TRIAL_LEAD_BUCKETS = [
  { key: 'under_1m', label: 'Under 1 month' },
  { key: '1_3m',     label: '1–3 months' },
  { key: '3_6m',     label: '3–6 months' },
  { key: '6_12m',    label: '6–12 months' },
  { key: 'over_12m', label: 'Over a year' },
];

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── shared helpers ─────────────────────────────────────────────────────────

function num(v) {
  return Number(v) || 0;
}

function pct(part, whole) {
  return whole ? Number(((part / whole) * 100).toFixed(2)) : 0;
}

/** Same session-storefront rule as /summary, as raw SQL on alias `s`. */
function sfSql(storefront) {
  if (!storefront) return Prisma.empty;
  if (storefront === 'INTL') return Prisma.sql`AND s.storefront = 'INTL'`;
  return Prisma.sql`AND (s.storefront = 'IN' OR s.storefront IS NULL)`;
}

/** The period of the same length immediately before [from, to]. */
function previousRange({ from, to }) {
  const span = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - span - 1), to: new Date(from.getTime() - 1) };
}

/**
 * Sessions that started in the range, each with flags for what it went on to do.
 * Returned as a SQL tail (FROM … WHERE …) to select and group over.
 */
function sessionsWithFlags(from, to, storefront) {
  return Prisma.sql`
    FROM WebsiteSession s
    LEFT JOIN (
      SELECT e.sessionId,
             MAX(e.type = 'view_template')     AS viewed,
             MAX(e.type = 'try_demo_created')  AS tried,
             MAX(e.type = 'initiate_checkout') AS checkout,
             MAX(e.type = 'purchase')          AS purchased
      FROM WebsiteEvent e
      WHERE e.createdAt >= ${from}
      GROUP BY e.sessionId
    ) f ON f.sessionId = s.id
    WHERE s.firstSeenAt >= ${from} AND s.firstSeenAt <= ${to} ${sfSql(storefront)}`;
}

const FLAG_COLUMNS = Prisma.sql`
  COUNT(*)                   AS visitors,
  COALESCE(SUM(f.viewed), 0)   AS viewed,
  COALESCE(SUM(f.tried), 0)    AS tried,
  COALESCE(SUM(f.checkout), 0) AS checkout,
  COALESCE(SUM(f.purchased), 0) AS purchased`;

function flagRow(r) {
  const visitors = num(r.visitors);
  const purchased = num(r.purchased);
  return {
    visitors,
    viewedTemplate: num(r.viewed),
    triedDemo: num(r.tried),
    startedCheckout: num(r.checkout),
    purchased,
    conversionRate: pct(purchased, visitors),
  };
}

/** Distinct sessions per event type in a range, on this storefront. */
async function eventSessionCounts(from, to, storefront, types) {
  const rows = await prisma.$queryRaw`
    SELECT e.type, COUNT(DISTINCT e.sessionId) AS c
    FROM WebsiteEvent e
    JOIN WebsiteSession s ON s.id = e.sessionId
    WHERE e.createdAt >= ${from} AND e.createdAt <= ${to}
      AND e.type IN (${Prisma.join(types)}) ${sfSql(storefront)}
    GROUP BY e.type`;
  const out = Object.fromEntries(types.map((t) => [t, 0]));
  for (const r of rows) out[r.type] = num(r.c);
  return out;
}

/** Distinct sessions per (design slug, event type). */
async function eventSessionsBySlug(from, to, storefront, types) {
  const rows = await prisma.$queryRaw`
    SELECT JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.slug')) AS slug, e.type, COUNT(DISTINCT e.sessionId) AS c
    FROM WebsiteEvent e
    JOIN WebsiteSession s ON s.id = e.sessionId
    WHERE e.createdAt >= ${from} AND e.createdAt <= ${to}
      AND e.type IN (${Prisma.join(types)})
      AND JSON_EXTRACT(e.metadata, '$.slug') IS NOT NULL ${sfSql(storefront)}
    GROUP BY slug, e.type`;
  const bySlug = new Map();
  for (const r of rows) {
    if (!r.slug) continue;
    const entry = bySlug.get(r.slug) || Object.fromEntries(types.map((t) => [t, 0]));
    entry[r.type] = num(r.c);
    bySlug.set(r.slug, entry);
  }
  return bySlug;
}

function paymentWhere(from, to, storefront, extra = {}) {
  return {
    createdAt: { gte: from, lte: to },
    ...(storefront ? { storefront } : {}),
    ...EXCLUDE_TEST_OWNER,
    ...extra,
  };
}

/** Real catalogue designs, keyed both ways. */
async function catalogue() {
  const templates = await prisma.template.findMany({
    where: EXCLUDE_SANDBOX_TEMPLATE,
    select: { id: true, slug: true, name: true, isActive: true },
  });
  return {
    bySlug: new Map(templates.map((t) => [t.slug, t])),
    byId: new Map(templates.map((t) => [t.id, t])),
  };
}

/** Day-of-week (0 = Sunday) and hour in IST. */
function istSlot(date) {
  const d = new Date(new Date(date).getTime() + IST_OFFSET_MIN * 60 * 1000);
  return { dow: d.getUTCDay(), hour: d.getUTCHours() };
}

function emptyGrid() {
  return Array.from({ length: 7 }, () => Array(24).fill(0));
}

function humanize(key) {
  return String(key || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function hourLabel(h) {
  const suffix = h < 12 ? 'am' : 'pm';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}${suffix}`;
}

/** The 3-hour window with the most visitors, across all days, and the busiest day. */
function peakWindows(grid) {
  const byHour = Array(24).fill(0);
  const byDay = Array(7).fill(0);
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      byHour[h] += grid[d][h];
      byDay[d] += grid[d][h];
    }
  }
  let bestStart = 0;
  let bestSum = -1;
  for (let h = 0; h < 24; h++) {
    const sum = byHour[h] + byHour[(h + 1) % 24] + byHour[(h + 2) % 24];
    if (sum > bestSum) { bestSum = sum; bestStart = h; }
  }
  const total = byDay.reduce((a, b) => a + b, 0);
  const bestDay = byDay.indexOf(Math.max(...byDay));
  return {
    total,
    byHour,
    byDay,
    peakHourStart: bestStart,
    peakHourShare: pct(bestSum, total),
    peakDay: bestDay,
    peakDayShare: pct(byDay[bestDay], total),
  };
}

// ─── insight rules ──────────────────────────────────────────────────────────

/**
 * Plain-sentence findings, most useful first. Pure: everything it needs is in
 * `ctx`, so the rules can be tested without a database.
 *
 * Each rule stays silent below a minimum sample rather than drawing a
 * conclusion from three visitors.
 *
 * @returns {{ tone: 'good'|'warn'|'info', title: string, detail: string, action: string }[]}
 */
function buildInsights(ctx) {
  const out = [];
  const { channels = [], templates = [], compare, timing, devices = [], tryLift, occasions = [], orders, untaggedShare } = ctx;
  const overallRate = ctx.overallRate || 0;

  // 1. Best channel, by tracked conversion.
  const sized = channels.filter((c) => c.visitors >= MIN_CHANNEL_VISITORS);
  const best = [...sized].filter((c) => c.purchased > 0).sort((a, b) => b.conversionRate - a.conversionRate)[0];
  if (best) {
    out.push({
      tone: 'good',
      title: `${best.label} is your best-converting channel`,
      detail: `${best.conversionRate}% of its ${best.visitors} visitors bought${overallRate ? `, against ${overallRate}% overall` : ''}.`,
      action: 'Shift budget toward it, and reuse what that campaign says and shows.',
    });
  }

  // 2. Channels that bring traffic but no sales.
  const leaky = sized
    .filter((c) => c.purchased === 0 && c.visitors >= MIN_CHANNEL_VISITORS * 2)
    .sort((a, b) => b.visitors - a.visitors)[0];
  if (leaky) {
    out.push({
      tone: 'warn',
      title: `${leaky.label} sends visitors who don't buy`,
      detail: `${leaky.visitors} visitors, ${leaky.viewedTemplate} looked at a design, none bought.`,
      action: 'Check the audience and the page the ad lands on — send it to a specific design, not the homepage.',
    });
  }

  // 3. Designs: the best converter, and the one with interest but no sales.
  const sizedTemplates = templates.filter((t) => t.viewers >= MIN_TEMPLATE_VIEWERS);
  const star = [...sizedTemplates].filter((t) => t.paidOrders > 0).sort((a, b) => b.viewToBuy - a.viewToBuy)[0];
  if (star) {
    out.push({
      tone: 'good',
      title: `Lead your next campaign with ${star.name}`,
      detail: `${star.viewToBuy}% of the people who looked at it bought (${star.paidOrders} of ${star.viewers}).`,
      action: 'Use it as the hero image of ads and posts; it already persuades.',
    });
  }
  const stalled = [...sizedTemplates]
    .filter((t) => t !== star && (t.paidOrders === 0 || (star && t.viewToBuy < star.viewToBuy / 3)))
    .sort((a, b) => b.viewers - a.viewers)[0];
  if (stalled) {
    out.push({
      tone: 'warn',
      title: `${stalled.name} gets looked at but rarely bought`,
      detail: `${stalled.viewers} people viewed it; ${stalled.paidOrders} bought.`,
      action: 'Interest is there — try a limited-time coupon on it, or retarget its viewers.',
    });
  }

  // 4. Try-it demos: do they lift sales?
  if (tryLift && tryLift.tried.sessions >= MIN_TRY_SESSIONS && tryLift.viewedOnly.sessions >= MIN_TRY_SESSIONS) {
    const a = tryLift.tried.rate;
    const b = tryLift.viewedOnly.rate;
    if (a > 0 && (b === 0 || a >= b * 1.5)) {
      out.push({
        tone: 'good',
        title: 'Trying a design with their own names sells',
        detail: b
          ? `Visitors who made a try-it demo bought at ${a}%, ${(a / b).toFixed(1)}× the ${b}% of those who only viewed a design.`
          : `Visitors who made a try-it demo bought at ${a}%; those who only viewed a design did not buy at all.`,
        action: 'Make "Try it with your names" the call to action in ads and reels.',
      });
    } else if (b > 0 && a < b) {
      out.push({
        tone: 'info',
        title: 'Try-it demos are not yet turning into sales',
        detail: `Demo makers bought at ${a}%, below the ${b}% of visitors who only viewed a design.`,
        action: 'Watch the demo-to-checkout step on the Try-it tab before promoting demos harder.',
      });
    }
  }

  // 5. When people shop.
  if (timing && timing.total >= 30) {
    const start = timing.peakHourStart;
    out.push({
      tone: 'info',
      title: `Visitors peak on ${DOW_NAMES[timing.peakDay]}s, around ${hourLabel(start)}–${hourLabel((start + 3) % 24)} IST`,
      detail: `${Math.round(timing.peakHourShare)}% of visits land in that 3-hour window; ${Math.round(timing.peakDayShare)}% on ${DOW_NAMES[timing.peakDay]}s.`,
      action: 'Schedule posts and weight ad budget toward that window.',
    });
  }

  // 6. Phones vs computers.
  const mobile = devices.find((d) => d.label === 'mobile');
  const desktop = devices.find((d) => d.label === 'desktop');
  const deviceTotal = devices.reduce((s, d) => s + d.visitors, 0);
  if (mobile && desktop && deviceTotal >= 50 && mobile.visitors >= MIN_CHANNEL_VISITORS && desktop.visitors >= MIN_CHANNEL_VISITORS) {
    const share = pct(mobile.visitors, deviceTotal);
    if (desktop.conversionRate > 0 && mobile.conversionRate < desktop.conversionRate / 2) {
      out.push({
        tone: 'warn',
        title: 'Phone visitors buy far less than computer visitors',
        detail: `${share}% of visitors are on phones, converting at ${mobile.conversionRate}% against ${desktop.conversionRate}% on computers.`,
        action: 'Walk through checkout on a phone; ads that run mostly on phones pay for this gap.',
      });
    } else if (share >= 60) {
      out.push({
        tone: 'info',
        title: `${share}% of visitors are on phones`,
        detail: 'Most shoppers see the site on a small screen.',
        action: 'Design ad creative vertical-first (Reels, Stories) and preview landing pages on a phone.',
      });
    }
  }

  // 7. Checkout leakage (authoritative: Payment rows).
  if (orders && orders.created >= 5) {
    const unfinished = orders.created - orders.paid;
    const share = pct(unfinished, orders.created);
    if (share >= 40) {
      out.push({
        tone: 'warn',
        title: `${share}% of orders were started but not paid`,
        detail: `${orders.created} orders opened, ${orders.paid} paid, ${orders.failed} failed at the gateway.`,
        action: 'An abandoned-checkout coupon or reminder could win some back; check failed payments first.',
      });
    }
  }

  // 8. Period over period.
  if (compare) {
    const v = compare.visitors;
    const o = compare.paidOrders;
    if (v.previous >= 20 && Math.abs(v.change) >= 20) {
      out.push({
        tone: v.change > 0 ? 'good' : 'warn',
        title: `Visitors ${v.change > 0 ? 'up' : 'down'} ${Math.abs(v.change)}% on the previous period`,
        detail: `${v.current} visitors against ${v.previous}.`,
        action: v.change > 0 ? 'Note which campaign was running — it is working.' : 'Check whether a campaign ended or a channel went quiet.',
      });
    }
    if (o.previous >= 3 && Math.abs(o.change) >= 25) {
      out.push({
        tone: o.change > 0 ? 'good' : 'warn',
        title: `Paid orders ${o.change > 0 ? 'up' : 'down'} ${Math.abs(o.change)}% on the previous period`,
        detail: `${o.current} paid orders against ${o.previous}.`,
        action: o.change > 0 ? 'Keep the current mix running.' : 'Compare the channel table with the previous period to find the gap.',
      });
    }
  }

  // 9. Demand for occasions the shop does not stock.
  const topAsk = occasions[0];
  if (topAsk && topAsk.count >= 3) {
    out.push({
      tone: 'info',
      title: `${topAsk.count} shoppers asked for ${topAsk.label} designs`,
      detail: occasions.slice(0, 3).map((o) => `${o.label}: ${o.count}`).join(' · '),
      action: 'Demand you are not serving yet — a design for it would have buyers waiting.',
    });
  }

  // 10. Untagged traffic hides what campaigns do.
  if (untaggedShare != null && untaggedShare >= 50 && ctx.visitors >= 50) {
    out.push({
      tone: 'info',
      title: `${untaggedShare}% of visits carry no source`,
      detail: 'Direct or untagged visits cannot be credited to any campaign.',
      action: 'Add utm_source and utm_campaign to every ad, bio and WhatsApp link so each campaign shows up here.',
    });
  }

  return out;
}

// ─── GET /api/v1/analytics/insights ─────────────────────────────────────────

async function getInsights(req, res) {
  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ ok: false, message: 'Invalid date range' });
  const { from, to } = range;
  const storefront = parseStorefront(req.query);
  const prev = previousRange(range);
  const tail = sessionsWithFlags(from, to, storefront);

  const [
    totalsRow,
    channelRows,
    deviceRows,
    countryRows,
    liftRows,
    sessionTimes,
    slugEvents,
    paidByTemplate,
    paidTimes,
    orderStatus,
    occasionRows,
    prevVisitors,
    prevPaid,
    curEvents,
    prevEvents,
    cat,
  ] = await Promise.all([
    prisma.$queryRaw`SELECT ${FLAG_COLUMNS} ${tail}`,
    prisma.$queryRaw`
      SELECT COALESCE(NULLIF(s.utmSource, ''), s.referrer, '(direct)') AS source,
             COALESCE(s.utmMedium, '')   AS medium,
             COALESCE(s.utmCampaign, '') AS campaign,
             ${FLAG_COLUMNS}
      ${tail}
      GROUP BY source, medium, campaign
      ORDER BY visitors DESC
      LIMIT 40`,
    prisma.$queryRaw`SELECT COALESCE(s.deviceType, 'unknown') AS label, ${FLAG_COLUMNS} ${tail} GROUP BY label ORDER BY visitors DESC`,
    prisma.$queryRaw`SELECT COALESCE(s.country, 'Unknown') AS label, ${FLAG_COLUMNS} ${tail} GROUP BY label ORDER BY visitors DESC LIMIT 12`,
    prisma.$queryRaw`
      SELECT COALESCE(f.tried, 0) AS tried, COUNT(*) AS sessions, COALESCE(SUM(f.purchased), 0) AS purchased
      ${tail} AND (f.viewed = 1 OR f.tried = 1)
      GROUP BY tried`,
    prisma.$queryRaw`
      SELECT DAYOFWEEK(DATE_ADD(s.firstSeenAt, INTERVAL ${IST_OFFSET_MIN} MINUTE)) AS dow,
             HOUR(DATE_ADD(s.firstSeenAt, INTERVAL ${IST_OFFSET_MIN} MINUTE)) AS h,
             COUNT(*) AS c
      FROM WebsiteSession s
      WHERE s.firstSeenAt >= ${from} AND s.firstSeenAt <= ${to} ${sfSql(storefront)}
      GROUP BY dow, h`,
    eventSessionsBySlug(from, to, storefront, ['view_template', 'demo_opened', 'try_demo_created', 'initiate_checkout']),
    prisma.payment.groupBy({
      by: ['templateId'],
      where: paymentWhere(from, to, storefront, { status: 'paid' }),
      _count: { _all: true },
    }),
    prisma.payment.findMany({
      where: paymentWhere(from, to, storefront, { status: 'paid' }),
      select: { createdAt: true },
    }),
    prisma.payment.groupBy({
      by: ['status'],
      where: paymentWhere(from, to, storefront),
      _count: { _all: true },
    }),
    prisma.$queryRaw`
      SELECT JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.aisle')) AS aisle, COUNT(DISTINCT e.sessionId) AS c
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.type = 'occasion_interest' AND e.createdAt >= ${from} AND e.createdAt <= ${to} ${sfSql(storefront)}
      GROUP BY aisle
      ORDER BY c DESC`,
    prisma.websiteSession.count({ where: { firstSeenAt: { gte: prev.from, lte: prev.to }, ...sessionStorefrontWhere(storefront) } }),
    prisma.payment.count({ where: paymentWhere(prev.from, prev.to, storefront, { status: 'paid' }) }),
    eventSessionCounts(from, to, storefront, ['initiate_checkout', 'try_demo_created']),
    eventSessionCounts(prev.from, prev.to, storefront, ['initiate_checkout', 'try_demo_created']),
    catalogue(),
  ]);

  const totals = flagRow(totalsRow[0] || {});

  const channels = channelRows.map((r) => {
    const label = [r.source, r.campaign].filter(Boolean).join(' · ');
    return { label, source: r.source, medium: r.medium || null, campaign: r.campaign || null, ...flagRow(r) };
  });
  const devices = deviceRows.map((r) => ({ label: String(r.label), ...flagRow(r) }));
  const countries = countryRows.map((r) => ({ label: String(r.label), ...flagRow(r) }));

  const liftBy = Object.fromEntries(liftRows.map((r) => [num(r.tried) ? 'tried' : 'viewedOnly', r]));
  const liftSide = (r) => ({ sessions: num(r?.sessions), purchased: num(r?.purchased), rate: pct(num(r?.purchased), num(r?.sessions)) });
  const tryLift = { tried: liftSide(liftBy.tried), viewedOnly: liftSide(liftBy.viewedOnly) };

  // Visitors heatmap from SQL (DAYOFWEEK is 1 = Sunday); orders heatmap in JS.
  const visitGrid = emptyGrid();
  for (const r of sessionTimes) visitGrid[num(r.dow) - 1][num(r.h)] += num(r.c);
  const orderGrid = emptyGrid();
  for (const p of paidTimes) {
    const { dow, hour } = istSlot(p.createdAt);
    orderGrid[dow][hour] += 1;
  }
  const timing = peakWindows(visitGrid);

  // Designs: interest from events (by slug), sales from payments (by id).
  const paidById = new Map(paidByTemplate.map((r) => [r.templateId, r._count._all]));
  const slugs = new Set([...slugEvents.keys()]);
  for (const id of paidById.keys()) {
    const t = cat.byId.get(id);
    if (t) slugs.add(t.slug);
  }
  const templates = [...slugs]
    .map((slug) => {
      const t = cat.bySlug.get(slug);
      if (!t) return null; // a sandbox design or an unknown slug
      const ev = slugEvents.get(slug) || {};
      const viewers = ev.view_template || 0;
      const paidOrders = paidById.get(t.id) || 0;
      return {
        id: t.id,
        slug,
        name: t.name,
        isActive: t.isActive,
        viewers,
        demoOpens: ev.demo_opened || 0,
        tryDemos: ev.try_demo_created || 0,
        checkouts: ev.initiate_checkout || 0,
        paidOrders,
        viewToBuy: pct(paidOrders, viewers),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.viewers - a.viewers || b.paidOrders - a.paidOrders);

  const statusCounts = Object.fromEntries(orderStatus.map((r) => [r.status, r._count._all]));
  const orders = {
    created: Object.values(statusCounts).reduce((a, b) => a + b, 0),
    paid: statusCounts.paid || 0,
    pending: statusCounts.pending || 0,
    failed: statusCounts.failed || 0,
    refunded: statusCounts.refunded || 0,
  };

  const occasions = occasionRows
    .filter((r) => r.aisle)
    .map((r) => ({ key: r.aisle, label: humanize(r.aisle), count: num(r.c) }));

  const change = (current, previous) => ({
    current,
    previous,
    change: previous ? Math.round(((current - previous) / previous) * 100) : null,
  });
  const compare = {
    visitors: change(totals.visitors, prevVisitors),
    checkouts: change(curEvents.initiate_checkout, prevEvents.initiate_checkout),
    tryDemos: change(curEvents.try_demo_created, prevEvents.try_demo_created),
    paidOrders: change(orders.paid, prevPaid),
  };

  const untagged = channels.filter((c) => c.source === '(direct)').reduce((s, c) => s + c.visitors, 0);
  const untaggedShare = totals.visitors ? Math.round((untagged / totals.visitors) * 100) : null;
  // Authoritative rate: Payment rows over visitors, as /summary reports it.
  const overallRate = pct(orders.paid, totals.visitors);

  const insights = buildInsights({
    channels, templates, compare, timing, devices, tryLift, occasions, orders,
    untaggedShare, overallRate, visitors: totals.visitors,
  });

  res.json({
    ok: true,
    range: { from: from.toISOString(), to: to.toISOString() },
    previousRange: { from: prev.from.toISOString(), to: prev.to.toISOString() },
    storefront: storefront || 'ALL',
    insights,
    totals,
    compare,
    orders,
    channels,
    templates,
    devices,
    countries,
    tryLift,
    occasions,
    timing: {
      timezone: 'IST',
      days: DOW_LABELS,
      visitors: visitGrid,
      paidOrders: orderGrid,
      peak: timing,
    },
  });
}

// ─── GET /api/v1/analytics/trial-demos ──────────────────────────────────────

async function getTrialDemos(req, res) {
  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ ok: false, message: 'Invalid date range' });
  const { from, to } = range;
  const storefront = parseStorefront(req.query);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const TRY_TYPES = ['try_demo_started', 'try_demo_created', 'try_demo_opened', 'try_demo_to_checkout'];

  const [
    liveRows,
    storedRows,
    todayCount,
    funnel,
    bySlug,
    dailyRows,
    sourceRows,
    deviceRows,
    viaRows,
    leadRows,
    ceremonyRows,
    demoOrders,
    demoPaidByTemplate,
    allPaid,
    cat,
  ] = await Promise.all([
    // Live now: the link still works. Design, age and views only.
    prisma.trialDemo.findMany({
      where: { linkExpiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, createdAt: true, linkExpiresAt: true, viewCount: true, payload: true,
        template: { select: { name: true, slug: true } },
        _count: { select: { payments: true } },
      },
    }),
    // The last day: every row the purge has not erased yet.
    prisma.trialDemo.findMany({
      where: { createdAt: { gte: dayAgo } },
      select: { viewCount: true, payload: true, payments: { select: { status: true } } },
    }),
    prisma.trialDemo.count({ where: { createdAt: { gte: startOfToday } } }),
    eventSessionCounts(from, to, storefront, TRY_TYPES),
    eventSessionsBySlug(from, to, storefront, ['view_template', ...TRY_TYPES]),
    prisma.$queryRaw`
      SELECT DATE(e.createdAt) AS d, e.type, COUNT(DISTINCT e.sessionId) AS c
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.createdAt >= ${from} AND e.createdAt <= ${to}
        AND e.type IN ('try_demo_created', 'try_demo_to_checkout') ${sfSql(storefront)}
      GROUP BY d, e.type
      ORDER BY d ASC`,
    prisma.$queryRaw`
      SELECT COALESCE(NULLIF(s.utmSource, ''), s.referrer, '(direct)') AS label, COUNT(DISTINCT e.sessionId) AS c
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.type = 'try_demo_created' AND e.createdAt >= ${from} AND e.createdAt <= ${to} ${sfSql(storefront)}
      GROUP BY label ORDER BY c DESC LIMIT 12`,
    prisma.$queryRaw`
      SELECT COALESCE(s.deviceType, 'unknown') AS label, COUNT(DISTINCT e.sessionId) AS c
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.type = 'try_demo_created' AND e.createdAt >= ${from} AND e.createdAt <= ${to} ${sfSql(storefront)}
      GROUP BY label ORDER BY c DESC`,
    prisma.$queryRaw`
      SELECT JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.via')) AS label, COUNT(*) AS c
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.type = 'try_demo_opened' AND e.createdAt >= ${from} AND e.createdAt <= ${to} ${sfSql(storefront)}
      GROUP BY label ORDER BY c DESC`,
    prisma.$queryRaw`
      SELECT JSON_UNQUOTE(JSON_EXTRACT(e.metadata, '$.lead')) AS label, COUNT(*) AS c
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.type = 'try_demo_created' AND e.createdAt >= ${from} AND e.createdAt <= ${to}
        AND JSON_EXTRACT(e.metadata, '$.lead') IS NOT NULL ${sfSql(storefront)}
      GROUP BY label`,
    prisma.$queryRaw`
      SELECT e.metadata AS meta
      FROM WebsiteEvent e
      JOIN WebsiteSession s ON s.id = e.sessionId
      WHERE e.type = 'try_demo_created' AND e.createdAt >= ${from} AND e.createdAt <= ${to}
        AND JSON_EXTRACT(e.metadata, '$.ceremonies') IS NOT NULL ${sfSql(storefront)}
      LIMIT 5000`,
    prisma.payment.groupBy({
      by: ['status', 'currency'],
      where: paymentWhere(from, to, storefront, { fromTrialDemo: true }),
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.payment.groupBy({
      by: ['templateId'],
      where: paymentWhere(from, to, storefront, { fromTrialDemo: true, status: 'paid' }),
      _count: { _all: true },
    }),
    prisma.payment.count({ where: paymentWhere(from, to, storefront, { status: 'paid' }) }),
    catalogue(),
  ]);

  const storefrontOf = (payload) => (payload && typeof payload === 'object' && payload.storefront) || 'IN';
  const onStorefront = (payload) => !storefront || storefrontOf(payload) === storefront;

  const live = liveRows.filter((r) => onStorefront(r.payload)).map((r) => ({
    id: r.id,
    design: r.template?.name || 'Unknown design',
    slug: r.template?.slug || null,
    createdAt: r.createdAt,
    minutesLeft: Math.max(0, Math.ceil((new Date(r.linkExpiresAt).getTime() - now.getTime()) / 60000)),
    views: r.viewCount,
    ceremonies: Array.isArray(r.payload?.ceremonies) ? r.payload.ceremonies.length : 0,
    storefront: storefrontOf(r.payload),
    startedCheckout: r._count.payments > 0,
  }));

  const stored = storedRows.filter((r) => onStorefront(r.payload));
  const last24h = {
    created: stored.length,
    opened: stored.filter((r) => r.viewCount > 0).length,
    // A link opened more than once has usually been forwarded — to a partner or
    // family on WhatsApp — which is the demo doing its job.
    openedMoreThanOnce: stored.filter((r) => r.viewCount > 1).length,
    totalViews: stored.reduce((s, r) => s + r.viewCount, 0),
    startedCheckout: stored.filter((r) => r.payments.length > 0).length,
    paid: stored.filter((r) => r.payments.some((p) => p.status === 'paid')).length,
  };

  // Sales from demos, authoritative, per currency.
  const revenue = new Map();
  let demoOrdersCreated = 0;
  let demoOrdersPaid = 0;
  for (const r of demoOrders) {
    demoOrdersCreated += r._count._all;
    if (r.status !== 'paid') continue;
    demoOrdersPaid += r._count._all;
    const entry = revenue.get(r.currency) || { currency: r.currency, amount: 0, orders: 0 };
    entry.amount += r._sum.amount || 0;
    entry.orders += r._count._all;
    revenue.set(r.currency, entry);
  }

  const daily = new Map();
  for (const r of dailyRows) {
    const date = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d);
    const entry = daily.get(date) || { date, created: 0, toCheckout: 0 };
    if (r.type === 'try_demo_created') entry.created = num(r.c);
    else entry.toCheckout = num(r.c);
    daily.set(date, entry);
  }

  const paidFromDemoById = new Map(demoPaidByTemplate.map((r) => [r.templateId, r._count._all]));
  const designs = [...bySlug.entries()]
    .map(([slug, ev]) => {
      const t = cat.bySlug.get(slug);
      if (!t) return null;
      return {
        slug,
        name: t.name,
        viewers: ev.view_template || 0,
        started: ev.try_demo_started || 0,
        created: ev.try_demo_created || 0,
        opened: ev.try_demo_opened || 0,
        toCheckout: ev.try_demo_to_checkout || 0,
        paid: paidFromDemoById.get(t.id) || 0,
        tryRate: pct(ev.try_demo_created || 0, ev.view_template || 0),
      };
    })
    .filter((d) => d && (d.started || d.created || d.paid))
    .sort((a, b) => b.created - a.created || b.started - a.started);

  const leadCounts = new Map(leadRows.map((r) => [r.label, num(r.c)]));
  const lead = TRIAL_LEAD_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: leadCounts.get(b.key) || 0 }));

  const ceremonyCounts = new Map();
  for (const row of ceremonyRows) {
    let meta = row.meta;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    const list = Array.isArray(meta?.ceremonies) ? meta.ceremonies : [];
    for (const name of list) {
      const key = String(name || '').trim();
      if (key && key.length <= 60) ceremonyCounts.set(key, (ceremonyCounts.get(key) || 0) + 1);
    }
  }
  const ceremonies = [...ceremonyCounts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const toRows = (rows) => rows.map((r) => ({ label: r.label == null ? 'Unknown' : String(r.label), count: num(r.c) }));

  res.json({
    ok: true,
    range: { from: from.toISOString(), to: to.toISOString() },
    storefront: storefront || 'ALL',
    settings: { linkMinutes: LINK_MINUTES, dataHours: DATA_HOURS, dailyCap: DAILY_CAP, createdToday: todayCount },
    live,
    last24h,
    funnel: {
      started: funnel.try_demo_started,
      created: funnel.try_demo_created,
      opened: funnel.try_demo_opened,
      toCheckout: funnel.try_demo_to_checkout,
      ordersCreated: demoOrdersCreated,
      paid: demoOrdersPaid,
    },
    sales: {
      paidOrders: demoOrdersPaid,
      shareOfAllPaid: pct(demoOrdersPaid, allPaid),
      revenue: [...revenue.values()],
    },
    daily: [...daily.values()],
    designs,
    sources: toRows(sourceRows),
    devices: toRows(deviceRows),
    openedVia: toRows(viaRows),
    lead,
    ceremonies,
  });
}

module.exports = { getInsights, getTrialDemos, buildInsights, TRIAL_LEAD_BUCKETS };
