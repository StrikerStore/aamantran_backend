if (process.env.NODE_ENV === 'production') {
  const secret = process.env.JWT_SECRET;
  if (!secret || String(secret).length < 32) {
    console.error(
      '[FATAL] JWT_SECRET must be set to a cryptographically strong value (at least 32 characters) in production.'
    );
    process.exit(1);
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

