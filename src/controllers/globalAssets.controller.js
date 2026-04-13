const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const objectStorage = require('../services/objectStorage');

const storage = require('../config/storage');

async function list(req, res) {
  try {
    const assets = await prisma.globalAsset.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ ok: true, assets });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function create(req, res) {
  try {
    const { type, name } = req.body;
    if (!req.file || !type || !name) {
      return res.status(400).json({ ok: false, message: 'Missing file, type, or name' });
    }

    const ext = path.extname(req.file.originalname) || '.mp3';
    const key = `assets/music/${uuidv4()}${ext}`;

    const buf = await fs.readFile(req.file.path);
    const ct = storage.contentTypeForPath(req.file.originalname) || 'audio/mpeg';

    if (storage.useObjectStorage()) {
      await objectStorage.putObject(key, buf, ct);
    } else {
      // Create local fallback if object storage not used
      const localPath = path.join(__dirname, '../../uploads', key);
      await fs.mkdir(path.dirname(localPath), { recursive: true }).catch(() => {});
      await fs.writeFile(localPath, buf);
    }
    
    await fs.unlink(req.file.path).catch(() => {});

    // Public URL logic identical to publicUploadUrl
    const url = storage.useObjectStorage()
      ? `${storage.objectStoragePublicBase()}/${key}`
      : `${req.protocol}://${req.get('host')}/uploads/${key}`;

    const asset = await prisma.globalAsset.create({
      data: { type, name, url }
    });

    res.json({ ok: true, asset });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function remove(req, res) {
  try {
    const asset = await prisma.globalAsset.findUnique({ where: { id: req.params.id } });
    if (!asset) return res.status(404).json({ ok: false, message: 'Not found' });

    await prisma.globalAsset.delete({ where: { id: req.params.id } });
    
    // Attempt cleanup
    if (storage.useObjectStorage()) {
      const urlPattern = /assets\/music\/[^\/]+$/;
      const match = asset.url.match(urlPattern);
      if (match) {
        await objectStorage.deleteObjectKey(match[0]).catch(() => {});
      }
    } else {
      try {
        const localPath = path.join(__dirname, '../../uploads', asset.url.split('/uploads/')[1]);
        await fs.unlink(localPath);
      } catch (e) {}
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = { list, create, remove };
