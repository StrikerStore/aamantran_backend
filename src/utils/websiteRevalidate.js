const siteUrls = require('../config/siteUrls');

/**
 * Tells both website deployments (aamantran.online and aamantranglobal.com) to
 * drop their cached copy of a part of the site, via the website's
 * app/api/revalidate route. Used after blog changes in the admin, so a post
 * appears (or disappears) on the next page load instead of after the
 * website's time-based cache runs out.
 *
 * Configuration:
 * - WEBSITE_REVALIDATE_SECRET: the same value as REVALIDATE_SECRET on both
 *   website deployments. Unset = this does nothing, and the websites fall back
 *   to their five-minute cache.
 * - WEBSITE_REVALIDATE_ORIGINS (optional): comma-separated origins to call
 *   instead of LANDING_URL and LANDING_URL_INTL, e.g. Railway's private URLs.
 *
 * Never throws and never blocks for long: a website that is slow or down is
 * logged and skipped, because the admin's change has already been saved and
 * the website's own cache will catch up within five minutes regardless.
 */

const TIMEOUT_MS = 5000;

function origins() {
  const override = String(process.env.WEBSITE_REVALIDATE_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const list = override.length ? override : [siteUrls.landingUrl(), siteUrls.landingUrlIntl()];
  return [...new Set(list.filter(Boolean))];
}

async function revalidateWebsites(scope) {
  const secret = String(process.env.WEBSITE_REVALIDATE_SECRET || '').trim();
  if (!secret) return { skipped: 'WEBSITE_REVALIDATE_SECRET is not set' };

  const results = await Promise.all(
    origins().map(async (origin) => {
      try {
        const res = await fetch(`${origin}/api/revalidate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ scope }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) console.warn(`[revalidate] ${origin} answered ${res.status} for "${scope}"`);
        return { origin, ok: res.ok, status: res.status };
      } catch (err) {
        console.warn(`[revalidate] ${origin} unreachable for "${scope}": ${err.message}`);
        return { origin, ok: false, error: err.message };
      }
    }),
  );
  return { results };
}

module.exports = {
  revalidateWebsites,
  revalidateBlog: () => revalidateWebsites('blog'),
};
