const express    = require('express');
const auth       = require('../middleware/auth');
const controller = require('../controllers/tickets.controller');

const router = express.Router();
router.use(auth);

router.get  ('/',              controller.list);
router.get  ('/:id',           controller.get);
router.post ('/:id/reply',     controller.reply);
router.patch('/:id/resolve',   controller.resolve);
router.patch('/:id/reopen',    controller.reopen);

module.exports = router;
