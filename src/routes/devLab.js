const express    = require('express');
const devAuth    = require('../middleware/devAuth');
const upload     = require('../middleware/upload');
const { labUploadLimiter } = require('../middleware/rateLimits');
const controller = require('../controllers/devLab.controller');

const router = express.Router();

// Every route below is developer-scoped. Nothing here can reach admin data:
// devAuth only accepts the `aamantran:dev` issuer, and each handler filters on
// req.dev.id rather than trusting an id from the request body.
router.use(devAuth);

const zipUpload = upload.fields([{ name: 'templateZip', maxCount: 1 }]);

// ── Templates ──
router.get   ('/templates',             controller.listTemplates);
router.post  ('/templates',             labUploadLimiter, zipUpload, controller.createTemplate);
router.put   ('/templates/:id/files',   labUploadLimiter, zipUpload, controller.replaceFiles);
router.get   ('/templates/:id/schema',  controller.getSchema);
router.put   ('/templates/:id/schema',  controller.putSchema);
router.post  ('/templates/:id/activate', controller.activate);
router.delete('/templates/:id',         controller.removeTemplate);

// ── Sandbox content ──
router.get ('/sandbox',        controller.getSandbox);
router.put ('/sandbox',        controller.putSandbox);
router.post('/sandbox/preset', controller.applyPreset);
router.post('/sandbox/reset',  controller.resetSandbox);

// ── Shared background-music library ──
router.get('/assets', controller.listAssets);

module.exports = router;
