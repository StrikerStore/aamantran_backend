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

const fileFilter = (_req, file, cb) => {
  const allowed = ['.zip', '.html', '.css', '.js', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.mp3', '.woff', '.woff2', '.ttf'];
  const ext = path.extname(file.originalname).toLowerCase();
  allowed.includes(ext) ? cb(null, true) : cb(new Error(`File type ${ext} not allowed`));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

module.exports = upload;
