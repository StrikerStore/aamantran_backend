const express = require('express');
const verifyUserJWT = require('../middleware/userAuth');
const c = require('../controllers/userDashboard.controller');

const router = express.Router();
router.use(verifyUserJWT);

// ── Support Tickets ───────────────────────────────────────────────────────────
router.get ('/',     c.listTickets);
router.post('/',     c.createTicket);
router.get ('/:id',  c.getTicket);
// Polled by an open thread every few seconds; deliberately cheap.
router.get ('/:id/messages', c.getTicketMessages);
router.post('/:id/reply', c.replyToTicket);

module.exports = router;
