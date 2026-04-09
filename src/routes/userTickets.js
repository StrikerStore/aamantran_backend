const express = require('express');
const verifyUserJWT = require('../middleware/userAuth');
const c = require('../controllers/userDashboard.controller');

const router = express.Router();
router.use(verifyUserJWT);

// ── Support Tickets ───────────────────────────────────────────────────────────
router.get ('/',     c.listTickets);
router.post('/',     c.createTicket);
router.get ('/:id',  c.getTicket);

module.exports = router;
