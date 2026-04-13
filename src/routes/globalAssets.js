const express = require('express');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');
const controller = require('../controllers/globalAssets.controller');

const router = express.Router();

router.get('/', controller.list);
router.post('/', auth, upload.single('file'), controller.create);
router.delete('/:id', auth, controller.remove);

module.exports = router;
