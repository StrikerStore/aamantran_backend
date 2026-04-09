const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadDir = path.resolve('./uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = String(file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

const allowed = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.avif', '.bmp',
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac',
  '.mp4', '.webm', '.mov',
]);

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (allowed.has(ext)) return cb(null, true);
  cb(new Error(`File type ${ext || '(none)'} not allowed for invitation media`));
};

const uploadUserMedia = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 },
});

module.exports = uploadUserMedia;
