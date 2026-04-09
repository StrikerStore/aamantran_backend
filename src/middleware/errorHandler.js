// Global error handler — catches all thrown errors from async routes
// (express-async-errors makes async throws reach here automatically)

module.exports = function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;

  if (process.env.NODE_ENV !== 'production') {
    console.error(`[ERROR] ${req.method} ${req.path} →`, err.message);
  } else if (status >= 500) {
    console.error(`[ERROR] ${req.method} ${req.path} →`, err.message);
  }

  res.status(status).json({
    ok:      false,
    message: status >= 500 ? 'Internal server error' : (err.message || 'Internal server error'),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
