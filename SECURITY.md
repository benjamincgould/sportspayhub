# Security

This covers the security review of October 2026 and the move to Next.js, Supabase and Vercel that followed it.

## The move to Next.js + Supabase (October 2026)

Every protection from the review was carried over. The 53 server tests from the old version were ported to the new code and pass against a real Postgres database with the same tables Supabase gets. Ten new tests cover what changed, for 63 in total. A real-browser walkthrough also passes with the strict security policy switched on.

**What changed, and why it's still safe**

| Area | Now |
| --- | --- |
| Passwords | Stored and checked by Supabase Auth (bcrypt). The app still applies its own rules first: 12+ characters, not common, not your name, email or club name, not in a known breach. Passwords over 72 bytes are refused rather than silently cut short. |
| Two-step codes | Authenticator apps are managed and checked by Supabase Auth. Recovery codes are kept by the app, as fingerprints only. Using one removes the lost phone, and staff add their new phone before they get in. |
| Sessions | The browser gets only a random id in an `HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` cookie. Supabase's tokens never reach the browser: they're kept encrypted in the app's database. Staff are still signed out after 30 idle minutes. Switching someone off also bans them in Supabase. |
| Database | All tables are in an `app` schema that Supabase's public API doesn't expose. Row-level security is on for every table and the public roles have no rights at all, so even if the schema were exposed by mistake, the public keys would read nothing. Only the app's server connects, after its own checks. |
| Rate limits | Kept in the database, so they hold across Vercel's many servers. Each visitor's own address is passed on to Supabase, so Supabase's limits apply per visitor rather than to the whole platform. |
| Security headers | Every page gets a strict Content-Security-Policy with a fresh random nonce, so only the app's own scripts run. The API keeps its strict policy too. |
| Webhooks | Stripe events must carry a valid signature. A club's account can only affect that club's members. |
| Clean-up | A daily job (Vercel Cron, protected by `CRON_SECRET`) removes expired sessions and links, old rate-limit records, activity older than a year, and sign-ups never confirmed within 7 days (their sign-in accounts too). |
| First-time set-up | The owner account is created at `/#/setup` with a one-time code from the server settings. It closes for good once an owner exists. |

**Found and fixed during the move:**
- Supabase signs a person out everywhere when an authenticator is removed. This would have left people stuck after using a recovery code or turning two-step off. They now continue on a fresh session. Tests cover both.
- Supabase limits two-step code checks to 15 a minute per address, and that limit can't be changed. With all sign-ins coming from the app's server, that limit would have been shared by everyone. The app now passes each visitor's address on, which needs the new `sb_secret_` key and IP forwarding switched on (see README).

## What the October review fixed (all carried over)

### High

| # | Problem | Fix |
| --- | --- | --- |
| H1 | **Staff could see other people's sign-in links.** "Password reset link" showed a coach or treasurer the reset link for a parent's active account, and invite links were always shown. Whoever opens a link sets the password, so a treasurer could take over a parent's account, read their child's medical details (which treasurers must never see) and lock the parent out. The owner could do the same with a new club's coach invite. | Reset links are **only ever emailed** to the account owner. Invite links are shown only to a coach, and only when email isn't set up. In production email is required, so links are never shown at all. The server won't start in production without email. |
| H2 | **The treasurer could give themselves access to any child.** By inviting their own second email as a "parent" and ticking a child, or with "Add or remove children", a treasurer could read that child's medical details. | Only coaches can invite people or link children to accounts. Coaches can already see medical details, so this gives nobody new access. |

### Medium

| # | Problem | Fix |
| --- | --- | --- |
| M1 | Behind a hosting proxy, the server used the visitor address that **visitors can make up**, so every rate limit (password guessing, sign-up spam) could be dodged. | It now uses the address the proxy itself recorded. `TRUST_PROXY` sets how many proxies there are. |
| M2 | Several sign-in attempts opened before an account locked could **keep guessing two-step codes** after the lock. | Codes are refused while an account is locked, and that sign-in attempt is ended. |
| M3 | Email addresses could contain `?`, `&` and `=`. A parent could set `x@y.nz?bcc=someone@else`, and a coach's reminder email would quietly copy that person in. Phone numbers had the same problem for text-message links. | Only plain addresses and phone numbers are accepted. The app also builds contact links from the bare address or digits only. |
| M4 | Parents' names, phone numbers, emails and home addresses were stored **unencrypted**. Only medical details were encrypted. | All contact and medical details are encrypted in the database (AES-256-GCM). Older databases are upgraded automatically on start-up. |
| M5 | There was **no way to delete** a child's, a person's or a club's data. | Coaches can delete a member, which removes their details, bookings, attendance, payment links and parent links. They can also delete a switched-off account, or cancel an unused invite. The owner can delete a whole club, after typing its name to confirm. Ledger entries stay, because clubs must keep financial records for tax. |
| M6 | "Forgot password" replied faster for emails with no account, which could reveal who has one. | Replies take the same time either way (sign-up too). |

### Low

| # | Problem | Fix |
| --- | --- | --- |
| L1 | Lockouts could last up to 24 hours, so someone could keep a coach locked out all day. | Lockouts last at most 1 hour. |
| L2 | Coaches' activity log showed parents' IP addresses. | Hidden from the log view. They're still stored for security checks and removed after a year. |
| L3 | A malformed web address could cause a server error. | Now a clear "not valid" reply. |
| L4 | A flood of sign-in attempts could queue up unlimited password checks in memory. | No longer applies: Supabase Auth checks passwords now, with its own limits per visitor. |
| L5 | The database file's permissions depended on the server's defaults. | No longer applies: the database is now hosted by Supabase. |
| L6 | Names and text accepted invisible and right-to-left control characters, which can disguise text on screen. | They're stripped from everything people type. |
| L7 | The activity log was kept forever, and stayed behind after a club was deleted. | Kept for one year. Deleting a club removes its log, and deleting an account scrubs the person's email from it. |
| L8 | The printable report was built from HTML text, and the app's own security policy blocked its styling. | It's now built safely element by element and keeps its styling. |
| L9 | The app would follow any address the server returned for payment pages. | It only follows secure `https://` pages. |
| L10 | IPv6 visitors could rotate addresses within their own connection to dodge limits. | Each IPv6 connection (a /64 block of addresses) counts as one visitor. |

Failed email sends also no longer write full email addresses into the server log.

## Still to do (outside the code)

1. **The first real build happens on Vercel.** Packages couldn't be downloaded where this was written, so the Next.js build itself, and the thin layer that calls Supabase (`lib/server/supabase.js`), have only been checked for syntax and against Supabase's documentation, not run. Everything behind them is tested. After deploying, walk through: owner set-up, a club sign-up, two-step setup, a recovery code, and a parent invite.
2. **Get an independent penetration test before real families join.** This review was done by the same AI that built the app.
3. **Keep `APP_ENCRYPTION_KEY` safe and separate.** Keep it in Vercel's environment settings and in your password manager, never in the code.
4. **Treat Supabase backups as sensitive.** They hold names and emails in plain text, and encrypted details that the key can unlock.
5. **Keep packages up to date.** Turn on GitHub's Dependabot alerts. Watch for Next.js security releases, which come out regularly, and redeploy when one lands.
6. **Supabase settings matter:** public sign-ups off, IP address forwarding on, leaked-password protection on. See README.
7. **Trust boundaries by design:** coaches see everything in their club; the owner can delete clubs; anyone with both the database and the key can read everything. Keep those accounts few, with two-step on.
8. **Legal:** terms of service, a privacy policy meeting the NZ Privacy Act 2020, and a data agreement with each club.
