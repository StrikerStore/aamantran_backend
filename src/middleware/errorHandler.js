// Global error handler — catches all thrown errors from async routes
// (express-async-errors makes async throws reach here automatically)

const multer = require('multer');

module.exports = function errorHandler(err, req, res, _next) {
  let status = err.status || err.statusCode || 500;
  if (err instanceof multer.MulterError) status = 400;

  if (process.env.NODE_ENV !== 'production') {
    console.error(`[ERROR] ${req.method} ${req.path} →`, err.message);
  } else if (status >= 500) {
    console.error(`[ERROR] ${req.method} ${req.path} →`, err.message);
  }

  const exposeServerMessage = process.env.NODE_ENV !== 'production' && status >= 500;
  res.status(status).json({
    ok: false,
    message:
      status >= 500 && !exposeServerMessage
        ? 'Internal server error'
        : (err.message || 'Internal server error'),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
