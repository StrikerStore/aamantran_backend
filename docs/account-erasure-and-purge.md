# Account erasure and test-event purge

Two deletes share one foreign-key order and then diverge. Copying one
payload onto the other either blocks the user delete or lets a test
payment count as revenue.

`DELETE /api/user/me` is the couple's erasure
(`src/controllers/accountDeletion.controller.js`).
`purgeTestEvents` (`src/services/testAccount.service.js`) wipes events
for the master testing user or a Template Lab sandbox user. The comment
on the purge says to keep the order in sync. The payment `data` is
intentionally not the same.

Consent, the unsubscribe link, the 88/90 day guest-data job, and the
one-time notice mailer stay in `docs/dpdp-compliance.md`. The Testing
page and the CLI password line stay in `docs/template-testing.md` and
`docs/test-account-cli.md`.

## Who can be deleted

`DELETE /api/user/me` requires the couple JWT (`verifyUserJWT`) and is
behind `authLoginLimiter`. The body is `{ "password": "..." }`.

| Case | Status | Body `message` |
| --- | --- | --- |
| Missing password | 400 | `Password confirmation is required to delete your account` |
| `User.isTestAccount` | 403 | `The testing account cannot be deleted here. Use the admin Testing page.` |
| Wrong password | 403 | `Incorrect password` |
| Deleted | 200 | `Your account and personal data have been deleted` |

The test-account check runs before the password compare. A wrong
password on that user still returns the testing-account message, and
nothing is written to `AuthAuditLog`. A wrong password on a normal user
is `account_delete_denied` (403, not 401, so the dashboard does not
treat it as an expired session). Success is `account_deleted`.

Lab sandbox users are `isTestAccount: true` as well
(`src/services/developerAccount.service.js`). They get the same 403.
Remove them with `DELETE /api/v1/testing/developers/:handle`, not
`/api/user/me`.

Checkout onboarding also refuses every flagged user (`403`, `This
username cannot be used for a purchase.` in
`src/routes/publicCheckout.js`). That is what keeps a payment row from
pointing at them. The purge does not clear `Payment.userId`, so a row
that was attached anyway still blocks a later `User` delete.

## Foreign keys that do not cascade

These relations have no `onDelete` in `prisma/schema.prisma`. They are
removed or detached before `Event` or `User` is deleted:

| Model | Why it is in the way |
| --- | --- |
| `InvitationEvent` | `eventId` and optional `guestId` have no cascade. Guest rows do cascade from `Event`, so the activity rows have to go first. |
| `TemplateSwapRequest` | `userId` and primary `eventId` have no cascade. `pairedEventId` is `onDelete: SetNull` and is not the blocker. |
| `SupportTicket` | `userId` and optional `eventId` have no cascade. `TicketMessage` cascades from the ticket. |
| `Payment` | `userId` and `eventId` are optional and have no cascade. |
| `TemplateReview` | `userId` has no cascade. `templateId` does. |
| `DeveloperAccount.sandboxUserId` | No cascade. The developer row has to go before the sandbox `User`. |
| `Event.templateId` / `Event.ownerId` | No cascade. Events go before the template or the user. |

Planning rows, guests, RSVPs, wishes, media, functions, venues, and
`EventRenderCache` cascade from `Event`.

## What each path writes

Both collect URLs first, then run one `prisma.$transaction`, then call
`objectStorage.tryDeletePublicUrl` per URL. A storage error is swallowed.
The database commit is not rolled back.

Collected URLs: `Media.url`, `EventPerson.photoUrl`,
`PhotoWallItem.url`, `MoodBoardPin.imageUrl`, and
`TemplateReview.couplePhotoUrl`. `files` on the purge result is how many
of those strings were non-empty. It is not how many objects were
removed.

`tryDeletePublicUrl` no-ops unless the URL is under
`R2_PUBLIC_BASE_URL`, and it skips keys that start with `assets/` (the
shared music library). Local `/uploads/...` files are left in place.
There is no prefix delete of `uploads/events/{id}/` or
`users/{id}/`, so an object with no row is left behind. A WhatsApp
share image is removed only when its URL is on a collected row.

| | `deleteAccount` | `purgeTestEvents` |
| --- | --- | --- |
| User row | Deleted | Kept |
| Events for that owner | Deleted | Deleted |
| Tickets, reviews, swaps | Deleted, even when the user has no events | Same |
| `Payment.userId` | Set null | Left as-is |
| `Payment.customerEmail` | Set null | Left as-is |
| `Payment.eventId` | Set null | Set null |
| Auth audit and email | `account_deleted`, then `sendAccountDeletedEmail` (send errors are logged, the HTTP 200 already happened) | Neither |
| `Template.avgRating` | Not recomputed | Not recomputed |
| `Template.buyerCount` | Not changed | Not changed |

Nulling `userId` is required before `User` can be deleted, and it is
why de-identified payments stay in admin revenue.
`EXCLUDE_TEST_OWNER` is `NOT { user: { is: { isTestAccount: true } } }`
(`src/utils/testFilters.js`), so a null owner is kept. The purge leaves
`userId` set on purpose: the flagged user still exists, and nulling the
column would make that payment look like a real sale. Do not "sync" the
two `data` objects.

Reviews are deleted and `recalcTemplateRating` is not called. Catalogue
pages that read the stored `Template.avgRating` keep the old number
until a later review write or `scripts/backfill-review-ratings.js`.

Guest-data retention (`src/services/dataRetention.service.js`) spreads
`EXCLUDE_TEST_EVENT`, so it never erases a test or lab invite. Purge is
the wipe for those rows.

## Who calls the purge

`purgeTestEvents(userId)` deletes every event owned by that id. With no
argument it calls `findTestUser()`:

1. `findFirst({ where: { isTestAccount: true } })` with no `orderBy`
2. else the user whose username is `TEST_ACCOUNT_USERNAME`

`ensureTestAccount` is the call that 409s when more than one row is
flagged. `findTestUser` does not. Lab sandbox users are flagged too, so
once a developer exists the no-arg purge is not pinned to the master
testing user.

| Caller | User it purges |
| --- | --- |
| `POST /api/v1/testing/load-template` and `POST /api/v1/testing/reset` | `findTestUser()`, then that id |
| `DELETE /api/v1/templates/:id` | No argument. Runs only when some `isTestEvent` row uses that template. The published-invite guard already ignores `isTestEvent`. |
| Lab activate, schema save that purges, template delete, and sandbox reset (`src/controllers/devLab.controller.js`) | `dev.sandboxUserId` |
| `DELETE /api/v1/testing/developers/:handle` | `dev.sandboxUserId`, then the developer row, then the sandbox user |

`DELETE /api/v1/templates/:id` counts lab invites (`isTestEvent: true`,
slug `lab-<handle>`) and then purges only `findTestUser()`. A sandbox
event on that template is still there, and `Event.templateId` has no
`onDelete`, so the template delete fails on the foreign key. The no-arg
purge also deletes every event of whichever flagged user it found, not
only events on the template being removed.

Developer removal order is fixed:

1. Remember template folder names.
2. `purgeTestEvents(sandboxUserId)` so the events release the templates.
3. `developerAccount.delete`. Sandbox templates cascade from
   `Template.sandboxOwnerId`.
4. `user.delete` for the sandbox user. This fails if a `Payment` still
   has that `userId` (the purge did not null it).
5. Folder deletes are best-effort and run after the rows are gone.

Load-template and Lab activate then create a new event. Reset does not.
None of these paths send the account-deleted email.
