require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const fs = require('fs');

const routes = require('./routes');
const webhookRouter = require('./routes/webhook');
const errorHandler = require('./middleware/errorHandler');
const siteUrls = require('./config/siteUrls');
const storage = require('./config/storage');
const { globalLimiter } = require('./middleware/rateLimits');
require('./services/scheduler');

const app = express();

// Behind Railway / reverse proxies — required for accurate client IP (rate limits, logs)
if (process.env.TRUST_PROXY === '0') {
  app.set('trust proxy', false);
} else {
  app.set('trust proxy', 1);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        imgSrc:     ["'self'", "data:", "blob:", "https:"],
        fontSrc:    ["'self'", "https://fonts.gstatic.com", "data:"],
        connectSrc: ["'self'", "https:"],
        mediaSrc:   ["'self'", "https:", "blob:"],
        // Razorpay checkout + YouTube/Vimeo embeds from demo/custom field URLs in templates
        frameSrc: [
          "'self'",
          'https://api.razorpay.com',
          'https://www.youtube.com',
          'https://www.youtube-nocookie.com',
          'https://player.vimeo.com',
        ],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// Permissions-Policy header (not built into helmet 8)
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Razorpay webhooks: raw body + signature — MUST be before express.json()
app.use(
  '/webhooks',
  express.raw({ type: 'application/json', limit: '2mb' }),
  webhookRouter
);

// ── CORS ─────────────────────────────────────────────────────────────
function toOrigin(value) {
  if (!value) return null;
  try {
    return new URL(String(value)).origin;
  } catch {
    return String(value).trim() || null;
  }
}

const localhostOrigins = process.env.NODE_ENV !== 'production'
  ? [
      'http://localhost:4000',
      'http://127.0.0.1:4000',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3001',
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]
  : [];

const allowedOrigins = Array.from(
  new Set(
    [
      toOrigin(siteUrls.landingUrl()),
      toOrigin(siteUrls.adminUrl()),
      toOrigin(siteUrls.coupleDashboardUrl()),
      toOrigin(siteUrls.apiBaseUrl()),
      toOrigin(process.env.R2_PUBLIC_BASE_URL),
      ...localhostOrigins,
    ].filter(Boolean)
  )
);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
  })
);

app.use(globalLimiter);

// ── BODY PARSING ─────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── STATIC: local disk only (R2 serves templates + media via public URL) ───
const storagePath = path.resolve(process.env.STORAGE_PATH || './storage');
if (!storage.useObjectStorage()) {
  app.use('/s', express.static(path.join(storagePath, 'templates')));
}

const uploadsPath = path.resolve('./uploads');
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath, { recursive: true });
if (!storage.useObjectStorage()) {
  app.use('/uploads', express.static(uploadsPath));
}

// ── ROUTES ───────────────────────────────────────────────────────────
app.use('/', routes);

// ── HEALTH CHECK ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date() }));

// ── GLOBAL ERROR HANDLER ─────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
