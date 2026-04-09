const express    = require('express');
const auth       = require('../middleware/auth');
const upload     = require('../middleware/upload');
const controller = require('../controllers/templates.controller');

const router = express.Router();

// All routes require admin JWT
router.use(auth);

router.get  ('/',           controller.list);
router.get  ('/:id',        controller.get);
router.post ('/',           upload.fields([
  { name: 'templateZip', maxCount: 1 },
  { name: 'thumbnailImage', maxCount: 1 }, // legacy
  { name: 'desktopThumbnailImage', maxCount: 1 },
  { name: 'mobileThumbnailImage', maxCount: 1 },
]), controller.create);
router.put  ('/:id',        upload.fields([
  { name: 'thumbnailImage', maxCount: 1 }, // legacy
  { name: 'desktopThumbnailImage', maxCount: 1 },
  { name: 'mobileThumbnailImage', maxCount: 1 },
]), controller.update);
router.put  ('/:id/files',  upload.fields([
  { name: 'templateZip', maxCount: 1 },
  { name: 'thumbnailImage', maxCount: 1 }, // legacy
  { name: 'desktopThumbnailImage', maxCount: 1 },
  { name: 'mobileThumbnailImage', maxCount: 1 },
]), controller.updateFiles);
router.put  ('/:id/demo-data', controller.updateDemoData);
router.patch('/:id/publish', controller.publish);
router.patch('/:id/draft',   controller.draft);
router.delete('/:id',        controller.remove);

module.exports = router;
