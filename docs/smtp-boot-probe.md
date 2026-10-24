# SMTP boot probe

Every process start sends one real message after the HTTP server is listening.
The recipient is fixed in source. `npm run check:env` does not send mail and
does not report this probe.

Code: the `listen` callback in `src/server.js`, `sendTestEmail` in
`src/services/email.service.js`.

## What is sent

| Piece | Value |
| --- | --- |
| To | `admin@plexzuu.com` |
| Subject | `Aamantran SMTP test email` |
| Body | `SMTP is configured correctly.` |
| From | `EMAIL_FROM`, else `SMTP_USER`, else `aamantran@plexzuu.com` |

The address is not `ADMIN_EMAIL`. Changing the admin login address does not
redirect the probe.

The send is not gated on `NODE_ENV`. `npm run dev` (nodemon) sends again on
each restart. Each production instance sends once per boot. A crash loop
sends one message per start.

The call is fire-and-forget. Traffic is accepted before the SMTP round trip
finishes. Success logs that SMTP is working and names the recipient. Failure
logs `SMTP test FAILED` and the error message. The process keeps running
either way.

## When it fails closed

`getTransport` throws before opening a socket when `SMTP_HOST`, `SMTP_USER`,
or `SMTP_PASS` is missing. `SMTP_PORT` defaults to `587`. Port `465` is the
only port that sets `secure: true`.

That throw is the failure log above. It is not the production boot exit.
Production boot exits only when `JWT_SECRET` is missing or shorter than 32
characters. The Razorpay webhook warning, the Razorpay test-key warning, and
the missing `TRIAL_IP_SALT` warning are separate `console.warn` lines and do
not send this message.

A configured SMTP account with a bad password fails the probe the same way:
one error line, process stays up, and later purchase or ticket mail fails
until the credentials work.

The transport is cached on the first successful build. A failed probe does
not cache a transport, so the next mail attempt builds it again.
