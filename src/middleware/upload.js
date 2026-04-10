const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

const uploadDir = path.resolve('./uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename:    (_req, file, cb)  => {
    const safe = String(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

// Template ZIP + static assets + demo / thumbnail media (keep in sync with uploadUserMedia where sensible)
const ALLOWED = new Set([
  '.zip', '.html', '.css', '.js', '.json',
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.avif', '.bmp', '.ico',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
  '.mp4', '.webm', '.mov',
  '.woff', '.woff2', '.ttf',
]);

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED.has(ext)) return cb(null, true);
  const err = new Error(`File type ${ext || '(none)'} not allowed`);
  err.status = 400;
  cb(err);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

module.exports = upload;
