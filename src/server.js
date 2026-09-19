if (process.env.NODE_ENV === 'production') {
  const secret = process.env.JWT_SECRET;
  if (!secret || String(secret).length < 32) {
    console.error(
      '[FATAL] JWT_SECRET must be set to a cryptographically strong value (at least 32 characters) in production.'
    );
    process.exit(1);
  }

  // Two settings whose absence breaks nothing visibly and costs real money.
  // Warnings, not exits: a running site that cannot verify a webhook is still
  // better than no site. `npm run check:env` reports the full picture.
  const isSet = (name) => typeof process.env[name] === 'string' && process.env[name].trim() !== '';

  if (isSet('RAZORPAY_KEY_ID') && !isSet('RAZORPAY_WEBHOOK_SECRET')) {
    console.warn(
      '[WARN] RAZORPAY_WEBHOOK_SECRET is not set: every Razorpay webhook will be refused, so a buyer who '
      + 'closes the tab mid-payment is charged and never completed.'
    );
  }
  if (isSet('RAZORPAY_KEY_ID') && String(process.env.RAZORPAY_KEY_ID).startsWith('rzp_test')) {
    console.warn('[WARN] RAZORPAY_KEY_ID is a TEST key on a production deployment: no real money will be taken.');
  }
  if (!isSet('TRIAL_IP_SALT')) {
    console.warn('[WARN] TRIAL_IP_SALT is not set: the per-IP cap on free previews cannot be applied.');
  }
}

const app = require('./app');
const { sendTestEmail } = require('./services/email.service');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Aamantran API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);

  sendTestEmail('admin@plexzuu.com')
    .then(() => console.log('[Email] SMTP is working — test mail sent to admin@plexzuu.com'))
    .catch(err => console.error('[Email] SMTP test FAILED:', err.message));
});

