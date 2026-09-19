#!/usr/bin/env node
/**
 * What this deployment is missing, before it costs someone money.
 *
 * Run it on the host after setting variables: `npm run check:env`.
 *
 * It exists because the expensive failures here are SILENT. A missing
 * RAZORPAY_WEBHOOK_SECRET does not crash anything: it means every webhook is
 * refused, so a buyer who closes the tab mid-payment is charged and never
 * completed, and nobody finds out until they write in. A missing TRIAL_IP_SALT
 * does not crash either: it means the per-IP cap on free previews cannot be
 * applied at all.
 *
 * Warnings only by default, so it can never block a deploy. `--strict` exits 1
 * when something required is missing, for use in a pipeline.
 */
require('dotenv').config();

const strict = process.argv.includes('--strict');
const isProd = process.env.NODE_ENV === 'production';

const set = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
};

const problems = [];
const notes = [];

/** @param {'required'|'advised'} level */
function need(level, name, why) {
  if (set(name)) return;
  (level === 'required' ? problems : notes).push({ name, why });
}

// ── Always required ──────────────────────────────────────────────────────────
need('required', 'DATABASE_URL', 'nothing works without the database');
need('required', 'JWT_SECRET', 'the server refuses to start in production without it');

// ── Payments ─────────────────────────────────────────────────────────────────
//
// Which gateway each storefront uses is an admin setting in the database, so
// this cannot say which keys are needed — only which pairs are incomplete. An
// incomplete pair is worse than an absent one: the admin page offers the
// gateway and every order through it is then refused.
const payuIndia = set('PAYU_MERCHANT_KEY') && set('PAYU_MERCHANT_SALT');
const payuIntl = set('PAYU_INTL_MERCHANT_KEY') && set('PAYU_INTL_MERCHANT_SALT');
const razorpay = set('RAZORPAY_KEY_ID') && set('RAZORPAY_KEY_SECRET');

if (!payuIndia && !razorpay) {
  problems.push({ name: 'PAYU_MERCHANT_KEY/SALT or RAZORPAY_KEY_ID/SECRET', why: 'no gateway is configured for India, so no order can be taken there' });
}
if (!razorpay && !payuIntl) {
  problems.push({ name: 'RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET', why: 'no gateway is configured for the global site, so no international order can be taken' });
}
if (set('RAZORPAY_KEY_ID') !== set('RAZORPAY_KEY_SECRET')) {
  problems.push({ name: 'RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET', why: 'half a key pair: set both or neither' });
}
if (razorpay && !set('RAZORPAY_WEBHOOK_SECRET')) {
  problems.push({
    name: 'RAZORPAY_WEBHOOK_SECRET',
    why: 'every Razorpay webhook is refused, so a buyer who closes the tab mid-payment is charged and never completed',
  });
}
if (razorpay && isProd && String(process.env.RAZORPAY_KEY_ID).startsWith('rzp_test')) {
  problems.push({ name: 'RAZORPAY_KEY_ID', why: 'this is a TEST key on a production deployment — no real money will be taken' });
}
if (payuIndia && isProd && (process.env.PAYU_ENV || 'prod') === 'test') {
  problems.push({ name: 'PAYU_ENV', why: 'set to test on a production deployment — PayU orders go to the test gateway' });
}
if (isProd && String(process.env.DUMMY_PAYMENT_MODE || '').toLowerCase() === 'true') {
  problems.push({ name: 'DUMMY_PAYMENT_MODE', why: 'test payment mode is ON in production — purchases complete without charging anyone' });
}

// ── Free previews ────────────────────────────────────────────────────────────
need('required', 'TRIAL_IP_SALT', 'without it the per-IP cap on free previews cannot be applied at all');

// ── Storage, email, and the sites ────────────────────────────────────────────
need('required', 'R2_ACCOUNT_ID', 'template and photo storage');
need('required', 'R2_ACCESS_KEY_ID', 'template and photo storage');
need('required', 'R2_SECRET_ACCESS_KEY', 'template and photo storage');
need('required', 'R2_BUCKET_NAME', 'template and photo storage');
need('advised', 'R2_PUBLIC_BASE_URL', 'media is served through the API instead of the CDN');
need('advised', 'SMTP_HOST', 'no email is sent — including purchase confirmations');
need('advised', 'LANDING_URL_INTL', 'falls back to the built-in default for the global storefront');
need('advised', 'ADMIN_EMAIL', 'nobody can sign in to the admin panel');

// ── Report ───────────────────────────────────────────────────────────────────
// Names only: a value is never printed, so this is safe to run where the output
// is logged.
const label = isProd ? 'production' : (process.env.NODE_ENV || 'development');
console.log(`Environment check (${label})\n`);

if (problems.length === 0 && notes.length === 0) {
  console.log('  Everything this deployment needs is set.');
} else {
  for (const p of problems) console.log(`  MISSING  ${p.name}\n           ${p.why}`);
  for (const n of notes) console.log(`  ADVISED  ${n.name}\n           ${n.why}`);
}

console.log(
  `\nGateways configured: India ${payuIndia ? 'PayU' : '—'}${payuIndia && razorpay ? ' + Razorpay' : razorpay && !payuIndia ? 'Razorpay' : ''}` +
  ` | Global ${razorpay ? 'Razorpay' : payuIntl ? 'PayU' : '—'}`,
);

if (strict && problems.length > 0) process.exit(1);
