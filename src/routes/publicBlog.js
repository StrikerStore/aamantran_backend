const express    = require('express');
const controller = require('../controllers/blog.controller');

const router = express.Router();

// Public — no auth required
router.get('/',      controller.listPublished);
router.get('/:slug', controller.getPublished);

module.exports = router;
