const express    = require('express');
const auth       = require('../middleware/auth');
const upload     = require('../middleware/upload');
const controller = require('../controllers/blog.controller');

const router = express.Router();

// All routes require admin JWT
router.use(auth);

router.get  ('/',                controller.list);
router.get  ('/:id',             controller.get);
router.post ('/',                upload.single('coverImage'), controller.create);
router.put  ('/:id',             upload.single('coverImage'), controller.update);
router.patch('/:id/publish',     controller.publish);
router.patch('/:id/unpublish',   controller.unpublish);
router.delete('/:id',           controller.remove);

module.exports = router;
