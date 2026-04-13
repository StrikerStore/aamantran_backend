const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const objectStorage = require('../services/objectStorage');

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
    const ct = objectStorage.contentTypeForPath(req.file.originalname) || 'audio/mpeg';

    await objectStorage.putObject(key, buf, ct);
    await fs.unlink(req.file.path).catch(() => {});

    const url = objectStorage.getPublicUrl(key);

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
    const urlPattern = /assets\/music\/[^\/]+$/;
    const match = asset.url.match(urlPattern);
    if (match) {
      await objectStorage.deleteObject(match[0]).catch(() => {});
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = { list, create, remove };
