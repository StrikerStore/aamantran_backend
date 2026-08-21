const express    = require('express');
const auth       = require('../middleware/auth');
const controller = require('../controllers/testing.controller');

const router = express.Router();
router.use(auth);

router.get ('/status',           controller.status);
router.post('/account',          controller.ensureAccount);
router.post('/rotate-password',  controller.rotate);
router.post('/load-template',    controller.loadTemplate);
router.post('/publish',          controller.setPublished);
router.post('/repin',            controller.repin);
router.post('/session',          controller.createSession);
router.post('/reset',            controller.reset);

module.exports = router;
