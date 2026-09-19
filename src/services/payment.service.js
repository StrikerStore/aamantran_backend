/**
 * The one place a payment becomes `paid`.
 *
 * Four different things can finish a purchase -- PayU's redirect, PayU's IPN,
 * Razorpay's browser confirmation and Razorpay's webhook -- and they can arrive
 * in any order, twice, or seconds apart. Before this module they were four
 * separate pieces of code that had already drifted: the redirect sent the
 * buyer's confirmation email and the IPN did not, so a buyer who closed the tab
 * after paying was marked paid and never received their onboarding link.
 *
 * Everything that means "this order is now paid" goes through markPaymentPaid.
 */
const prisma = require('../utils/prisma');
const siteUrls = require('../config/siteUrls');
const { landingUrlFor } = require('../utils/storefront');
const {
  sendPurchaseConfirmationEmail,
  sendAdminOrderPlacedEmail,
} = require('./email.service');

const PAYU = 'payu';

/** The onboarding link for a paid order, on the storefront it was bought from. */
function onboardingUrlFor(payment) {
  const landing = landingUrlFor(payment.storefront);
  const parts = [
    `paymentId=${encodeURIComponent(payment.id)}`,
    `slug=${encodeURIComponent(payment.template.slug)}`,
    `template=${encodeURIComponent(payment.template.name)}`,
    payment.orderId ? `orderId=${encodeURIComponent(payment.orderId)}` : '',
    `amount=${payment.amount}`,
    `currency=${encodeURIComponent(payment.currency || 'INR')}`,
  ].filter(Boolean);
  return `${landing}/onboarding?${parts.join('&')}`;
}

/**
 * Mark a payment paid, whichever gateway took it, and tell the buyer and the team.
 *
 * `gatewayPaymentId` is PayU's mihpayid or Razorpay's pay_… id. It is written to
 * the generic column always, and additionally to payuMihpayid on a PayU order so
 * the two stay mirrored (see the Payment model) and the PayU refund path keeps
 * working unchanged.
 *
 * ONLY ONE CALLER WINS. The transition out of `pending` is claimed inside the
 * transaction: whoever gets there first does the work, and anyone arriving after
 * gets the row back untouched and sends nothing. Two callers arriving together
 * is not an edge case with Razorpay -- the browser's verify call and Razorpay's
 * webhook routinely land within the same second -- and without the claim both
 * would mean two confirmation emails, two team alerts and buyerCount counted
 * twice. The same protection now covers PayU's redirect racing PayU's IPN.
 *
 * @param {object} payment   the row as read, including its `gateway`
 * @param {string} gatewayPaymentId
 * @returns {Promise<object>} the payment, with `template` included
 */
async function markPaymentPaid(payment, gatewayPaymentId) {
  const isPayu = String(payment.gateway || PAYU) === PAYU;

  const { row, claimed } = await prisma.$transaction(async (tx) => {
    const claim = await tx.payment.updateMany({
      where: { id: payment.id, status: { not: 'paid' } },
      data: {
        status: 'paid',
        gatewayPaymentId: gatewayPaymentId || null,
        ...(isPayu ? { payuMihpayid: gatewayPaymentId || null } : {}),
      },
    });
    const current = await tx.payment.findUnique({
      where:   { id: payment.id },
      include: { template: { select: { name: true, slug: true } } },
    });
    if (claim.count === 0) return { row: current, claimed: false };

    await tx.template.update({
      where: { id: payment.templateId },
      data:  { buyerCount: { increment: 1 } },
    });
    return { row: current, claimed: true };
  });

  // Someone else already finished this payment, emails included.
  if (!claimed) return row;

  if (row.customerEmail) {
    // Back to the site they actually bought from: an international buyer must
    // not be emailed a link to the India storefront.
    sendPurchaseConfirmationEmail({
      to:           row.customerEmail,
      templateName: row.template.name,
      amount:       row.amount,
      currency:     row.currency,
      orderId:      row.orderId || null,
      onboardingUrl: onboardingUrlFor(row),
    }).catch((err) => console.error('[Email Error]', err.message));
  }

  // Team notification. Fired whether or not the buyer left an email, and never
  // awaited: a mail failure must not roll back money the gateway has taken.
  sendAdminOrderPlacedEmail({
    orderId:        row.orderId,
    templateName:   row.template.name,
    amount:         row.amount,
    currency:       row.currency,
    storefront:     row.storefront,
    discountAmount: row.discountAmount,
    couponCode:     row.couponCode,
    customerEmail:  row.customerEmail,
    paymentId:      row.id,
    gateway:        row.gateway,
    gatewayRef:     row.gatewayPaymentId,
    purchasedAt:    new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
    adminUrl:       `${siteUrls.adminUrl()}/transactions/${row.id}`,
  }).catch((err) => console.error('[Email Error]', err.message));

  return row;
}

/**
 * Mark a still-pending payment failed. Never touches a paid one: a late failure
 * notice for an order that has already settled must not un-sell it.
 */
async function markPaymentFailed(where) {
  return prisma.payment.updateMany({ where: { ...where, status: 'pending' }, data: { status: 'failed' } });
}

module.exports = { markPaymentPaid, markPaymentFailed, onboardingUrlFor };
