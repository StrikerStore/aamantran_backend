const express      = require('express');
const router       = express.Router();

const authRoutes           = require('./auth');
const templateRoutes       = require('./templates');
const userRoutes           = require('./users');
const transactionRoutes    = require('./transactions');
const ticketRoutes         = require('./tickets');
const couponRoutes         = require('./coupons');
const renderRoutes         = require('./render');
const publicCheckoutRoutes = require('./publicCheckout');
const publicInviteRoutes   = require('./publicInvite');

// ── User Dashboard API ────────────────────────────────────────────────
const userAuthRoutes    = require('./userAuth');
const userEventRoutes   = require('./userEvents');
const userTicketRoutes  = require('./userTickets');
const userProfileRoutes = require('./userProfile');

// ── R2 asset proxy (no auth) — must be first so CSP/CORS never applies ──────
const r2ProxyRoutes = require('./r2Proxy');
router.use('/r2-proxy', r2ProxyRoutes);

// ── Public — invitation rendering ────────────────────────────────────
router.use('/', renderRoutes);


const globalAssetsRoutes   = require('./globalAssets');

// ── Admin API (JWT-protected inside each router) ─────────────────────
router.use('/api/v1/auth',         authRoutes);
router.use('/api/v1/templates',    templateRoutes);
router.use('/api/v1/users',        userRoutes);
router.use('/api/v1/transactions', transactionRoutes);
router.use('/api/v1/tickets',      ticketRoutes);
router.use('/api/v1/coupons',      couponRoutes);
router.use('/api/v1/assets',       globalAssetsRoutes);
router.use('/api/assets',          globalAssetsRoutes); // Public GET access

// ── User Dashboard API (JWT-protected, role: user) ───────────────────
router.use('/api/user/auth',       userAuthRoutes);
router.use('/api/user/events',     userEventRoutes);
router.use('/api/user/tickets',    userTicketRoutes);
router.use('/api/user',            userProfileRoutes);

// ── Public template/review endpoints (for landing page) ──────────────
const publicTemplateRoutes = require('./publicTemplates');
router.use('/api/templates',  publicTemplateRoutes);
router.use('/api/reviews',    publicTemplateRoutes); // reuse, separate handler
router.use('/api/checkout',   publicCheckoutRoutes);
router.use('/api/public',     publicInviteRoutes);
router.use('/api/contact',   require('./contact'));

module.exports = router;
