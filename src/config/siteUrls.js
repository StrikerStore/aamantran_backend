/**
 * Canonical public URLs for emails, CORS, invite links, and media.
 * Env vars always win; in production, sensible defaults point at aamantran.online.
 */
const isProd = () => process.env.NODE_ENV === 'production';

const DEFAULTS = {
  dev: {
    API_BASE_URL: 'http://localhost:4000',
    LANDING_URL: 'http://localhost:3000',
    COUPLE_DASHBOARD_URL: 'http://localhost:3001',
    ADMIN_URL: 'http://localhost:5174',
    LAB_URL: 'http://localhost:5175',
  },
  prod: {
    API_BASE_URL: 'https://api.aamantran.online',
    LANDING_URL: 'https://www.aamantran.online',
    COUPLE_DASHBOARD_URL: 'https://app.aamantran.online',
    ADMIN_URL: 'https://admin.aamantran.online',
    LAB_URL: 'https://lab.aamantran.online',
  },
};

function pick(key) {
  const envVal = process.env[key];
  if (envVal != null && String(envVal).trim() !== '') {
    return String(envVal).replace(/\/$/, '');
  }
  const d = isProd() ? DEFAULTS.prod : DEFAULTS.dev;
  return d[key];
}

module.exports = {
  apiBaseUrl: () => pick('API_BASE_URL'),
  landingUrl: () => pick('LANDING_URL'),
  coupleDashboardUrl: () => pick('COUPLE_DASHBOARD_URL'),
  adminUrl: () => pick('ADMIN_URL'),
  /** Template Lab — the external template developers' sandbox app. */
  labUrl: () => pick('LAB_URL'),
};
