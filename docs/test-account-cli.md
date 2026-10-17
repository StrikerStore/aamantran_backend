# Test-account CLI

`npm run test:account` runs `scripts/ensure-test-account.js`. It creates or
adopts the master template-testing user. The admin Testing page is the normal
way; the script is for a shell, or for a row that was deleted in the database.

```
npm run test:account
npm run test:account -- --password 'some-secret'
```

The flag is optional. With no flag, a new user gets 12 characters of
base64url (`crypto.randomBytes(9)`), which clears the password policy. The
plaintext is printed once. Only a bcrypt hash is stored.

Identity is `User.isTestAccount`, not the username. Defaults when the env
vars are unset: username `aamantran-test`, email `test@aamantran.online`.
Both are lowercased, because login looks up `username.trim().toLowerCase()`.
`TEST_ACCOUNT_USERNAME`, `TEST_ACCOUNT_EMAIL`, and `TEST_EVENT_SLUG` override
them. The slug is not used by this script; the Testing API uses it when it
creates the invitation.

## The password line lies on update

`ensureTestAccount` (`src/services/testAccount.service.js`) returns
`generatedPassword: null` whenever the user already exists. The CLI prints
that null as:

```
[test-account] password unchanged (pass --password to rotate).
```

That sentence is true only when you did not pass `--password`.

When the row exists and `--password` is passed:

1. `validateNewPassword` runs. A rejection throws, the script prints
   `failed:`, and the hash is not written. Rules: 8 to 128 characters, not a
   single repeated character, not a small blocklist of common passwords.
2. On success the hash is replaced (`bcrypt`, cost 12) and `isTestAccount`
   is set.
3. `generatedPassword` stays null.
4. The CLI still prints "password unchanged".

The new password is the one you passed. It is not echoed. User JWTs carry
`pv`, a short hash of `passwordHash` (`passwordVersion` in
`src/utils/authSecurity.js`), so this write does invalidate sessions even
though the log line says nothing changed.

A first create prints the password and `created`. A later run with no flag
updates nothing about the hash and the "unchanged" line is correct.

Do not "fix" the CLI in a drive-by. Callers already look for that log line.
The admin rotate route is the one that returns plaintext on purpose.

## Admin routes that share the function

| Call | Function | Plaintext in the JSON |
| --- | --- | --- |
| `POST /api/v1/testing/account` with `{ "password": "..." }` | `ensureTestAccount` | only when `created` is true. On an existing row `generatedPassword` is null even though the hash was updated. Same trap as the CLI. |
| `POST /api/v1/testing/account` with no password | `ensureTestAccount` | the generated password when the row was just created; null when it already existed |
| `POST /api/v1/testing/rotate-password` | `rotatePassword` | always the new password, generated or the one you sent |

`rotatePassword` 404s if the account has not been created yet. The CLI never
calls it.

More than one row with `isTestAccount: true` throws 409 and lists
`username:id`. Clear the flag on all but one. Adoption order: the flagged
row first, otherwise a row whose username is `TEST_ACCOUNT_USERNAME`.
