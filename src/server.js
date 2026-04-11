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
const { ensureBucketCors } = require('./services/objectStorage');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Aamantran API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);

  // Apply R2 bucket CORS policy so template assets (JS/CSS) can be loaded
  // cross-origin when the invite/demo is served from the API domain.
  ensureBucketCors().catch((err) =>
    console.warn('[R2] Failed to apply CORS policy:', err?.message || err)
  );
});
