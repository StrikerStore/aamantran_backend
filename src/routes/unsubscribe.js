const express = require('express');
const prisma = require('../utils/prisma');
const { verifyUnsubscribeToken } = require('../utils/unsubscribe');
const { lookupLimiter } = require('../middleware/rateLimits');

const router = express.Router();

function page(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;background:#f5ede6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
.card{background:#fff;border-radius:16px;padding:40px 36px;max-width:440px;text-align:center;box-shadow:0 4px 24px rgba(110,31,46,0.10);}
h1{color:#6e1f2e;font-size:22px;margin:0 0 12px;}p{color:#5a3a3a;font-size:15px;line-height:1.6;margin:0;}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

// GET /api/unsubscribe?email=&token= — one-click opt-out from marketing emails
router.get('/', lookupLimiter, async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const token = String(req.query.token || '');

  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    return res.status(400).send(page('Invalid link', 'This unsubscribe link is invalid or has expired. Please contact aamantran@plexzuu.com.'));
  }

  await prisma.payment.updateMany({
    where: { customerEmail: email },
    data: { marketingOptIn: false },
  });

  return res.send(page('You are unsubscribed', `${email} will no longer receive reminder or offer emails from Aamantran. Transactional emails about purchases you complete are unaffected.`));
});

module.exports = router;
