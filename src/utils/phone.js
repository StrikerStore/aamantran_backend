/**
 * Phone numbers, normalised once and in one place.
 *
 * Called by checkout, onboarding, the profile update and the PayU param builder
 * -- never re-implemented per form, because the stakes are asymmetric: a couple's
 * number is WRITE-ONCE (userDashboard.controller.js refuses to change it and
 * sends them to a support ticket), so a number captured wrong is permanent.
 *
 * The number is stored split -- dial code in one column, national digits in
 * another -- rather than as one E.164 string, so the picker can re-render
 * without a parsing library. '+1' and '+1242' cannot be separated by looking at
 * the string alone. Canonical E.164 is the concatenation.
 *
 * Replaces the old `String(contact).replace(/\D/g, '').slice(0, 10)`, which
 * assumed an Indian number and silently mangled every international one:
 * +1 415 555 0123 became 1415555012.
 */
const { DIAL_CODES_BY_LENGTH } = require('../lib/dialCodes');

const DEFAULT_DIAL = '+91';

// E.164 caps the whole number, country code included, at 15 digits. The lower
// bound is deliberately loose -- national numbering plans vary far more than
// people expect, and refusing a valid short number is worse than accepting an
// odd one, given the number can never be corrected later.
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

/** Digits only, with a single leading '+' preserved. '00' is treated as '+'. */
function tidy(raw) {
  let s = String(raw == null ? '' : raw).trim();
  s = s.replace(/^00/, '+');
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  return { digits, explicitInternational: plus };
}

/** Normalise a picker value like ' 91 ' or '+91' to '+91'. */
function normalizeDialCode(raw) {
  const { digits } = tidy(raw);
  if (!digits) return null;
  return '+' + digits.replace(/^0+/, '');
}

/** The longest known dial code that prefixes these digits, or null. */
function matchDialCode(digits) {
  for (const code of DIAL_CODES_BY_LENGTH) {
    if (digits.startsWith(code.slice(1))) return code;
  }
  return null;
}

/**
 * Split what someone typed into a dial code and a national number.
 *
 * The rule that keeps this unambiguous: a dial code is only ever stripped OFF
 * the number when the user explicitly wrote '+' or '00'. Without that marker the
 * picker is trusted and only a single leading trunk zero is dropped.
 *
 * That restraint matters. With a '+1' picker and '1234567890' typed, a stray
 * country code and a real leading '1' are indistinguishable -- so guessing would
 * silently delete a digit from a valid number. Better to keep it and let a
 * length check complain.
 *
 * When an explicit '+' disagrees with the picker, the TYPED code wins and the
 * caller is expected to move the picker to match: someone who took the trouble
 * to type +1 into a +91 form meant +1.
 *
 * @returns {{countryCode: string, national: string, e164: string,
 *            valid: boolean, reason: string|null, correctedCountryCode: boolean}}
 */
function normalizePhone(rawCode, rawNumber) {
  const picker = normalizeDialCode(rawCode) || DEFAULT_DIAL;
  const { digits, explicitInternational } = tidy(rawNumber);

  let countryCode = picker;
  let national = digits;
  let correctedCountryCode = false;

  if (explicitInternational && digits) {
    const matched = matchDialCode(digits);
    if (matched) {
      countryCode = matched;
      national = digits.slice(matched.length - 1);
      correctedCountryCode = matched !== picker;
    } else {
      // A '+' with no recognisable code. Keep the digits whole rather than
      // inventing a split; the length check below decides whether it stands.
      national = digits;
    }
  } else {
    national = national.replace(/^0/, '');
  }

  const e164Digits = countryCode.slice(1) + national;
  let reason = null;

  if (!national) {
    reason = 'Contact number is required';
  } else if (e164Digits.length < MIN_E164_DIGITS || e164Digits.length > MAX_E164_DIGITS) {
    reason = 'That contact number does not look complete';
  } else if (countryCode === '+91' && !/^[6-9]\d{9}$/.test(national)) {
    // Kept from the pre-existing India rule -- every Indian mobile is ten
    // digits starting 6-9, and this is still the overwhelming majority of
    // traffic, so it is worth catching a typo here specifically.
    reason = 'Enter a valid 10-digit Indian mobile number';
  }

  return {
    countryCode,
    national,
    e164: '+' + e164Digits,
    valid: reason === null,
    reason,
    correctedCountryCode,
  };
}

/**
 * Digits for a payment gateway: full E.164 without the '+', never truncated.
 *
 * Falls back to the raw digits if the pair does not validate, because a checkout
 * must not be blocked by a phone format the gateway would have tolerated.
 */
function normalizePhoneForGateway(rawCode, rawNumber) {
  if (!rawNumber) return '';
  const parsed = normalizePhone(rawCode, rawNumber);
  if (parsed.national) return parsed.e164.slice(1);
  return String(rawNumber).replace(/\D/g, '');
}

/** Display form for admin screens and emails: '+91 9876543210'. */
function formatPhone(countryCode, national) {
  if (!national) return '';
  const code = normalizeDialCode(countryCode) || DEFAULT_DIAL;
  return code + ' ' + national;
}

module.exports = {
  DEFAULT_DIAL,
  normalizeDialCode,
  normalizePhone,
  normalizePhoneForGateway,
  formatPhone,
};
