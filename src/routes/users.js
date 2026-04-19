const express    = require('express');
const auth       = require('../middleware/auth');
const uploadUserMedia = require('../middleware/uploadUserMedia');
const controller = require('../controllers/users.controller');

const router = express.Router();
router.use(auth);

function maybeUserMediaUpload(req, res, next) {
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('multipart/form-data')) {
    return uploadUserMedia.single('file')(req, res, next);
  }
  next();
}

router.get  ('/',                        controller.list);
router.get  ('/:id/events/:eventId/preview-token', controller.getEventPreviewToken);
router.get  ('/:id',                     controller.get);
router.patch('/:id/profile',             controller.updateProfile);
router.patch('/:id/reset-password',      controller.resetPassword);
router.patch('/:id/freeze-names',        controller.freezeNames);
router.post ('/:id/events/:eventId/media',       maybeUserMediaUpload, controller.uploadEventMediaAsAdmin);
router.delete('/:id/events/:eventId/media/:mediaId', controller.deleteEventMediaAsAdmin);
router.put  ('/:id/event-data',          controller.updateEventData);
router.post ('/:id/swap-template',       controller.swapTemplate);
router.post ('/:id/swap-paired-template', controller.swapPairedTemplate);
router.patch('/:id/change-template',      controller.changeTemplate);
router.post ('/:id/generate-invites',   controller.generatePairedInvites);

module.exports = router;
