# Club App

An app any sports club can sign up to. Each club gets its own private space with its own name, sport, words, colour and logo. Clubs try it with sample data for free, then pay you a monthly subscription to use it. You can also give any club free access.

**Built with:** Next.js 16 on Vercel (Pro), Supabase (Pro) for the database and sign-in, Stripe for payments, and Resend or Postmark for email.

## Building and testing on free plans

You can build and test everything on free plans. A few things work differently:

- **Vercel Hobby** is for non-commercial use only, which covers building and testing with Stripe in test mode. Move to Pro before taking real payments. The clean-up job runs once a day, because Hobby doesn't allow more often.
- **Supabase Free** pauses a project after 7 days without use; restore it from the dashboard. It also has **no automatic backups**, so don't put real families' details in it. Skip the Pro-only steps below: leaked-password protection and session time-boxing. The app still checks passwords against known breaches itself.
- **Resend Free** sends up to 100 emails a day. Until you verify your own domain, use `EMAIL_FROM=onboarding@resend.dev`. Resend will then only deliver to the email address you signed up to Resend with, so test with that address, or with `+` variations of it if Resend accepts them.
- **Stripe** test mode is free. Use card `4242 4242 4242 4242`.

| Folder | What it is |
| --- | --- |
| `app/` | The Next.js app: the page, and the API routes (`/api/...`, Stripe's `/api/webhook`, the daily `/api/cron/sweep`) |
| `components/` | The screens: sign-in, club sign-up, the parent, treasurer and coach screens, and your owner console |
| `lib/server/` | Checks who's signed in, keeps every club's data separate, decides who may see what, and talks to Supabase and Stripe |
| `supabase/migrations/` | The database tables, run once in Supabase |
| `tests/` | 63 automated server tests and a real-browser walkthrough |

## Who's who

- **You, the platform owner.** You sign in to the **Owner Console**. There you see every club, whether it's paying, previewing or free, and roughly what you earn each month. You can give a club free access, put it back on its normal subscription, switch it off, set one up for someone, or delete it. You never see a club's members, contact details or medical information.
- **Coaches.** Each club's first coach is the person who signed it up. Coaches can do everything in their club, including billing, branding, groups, attendance and inviting people.
- **Treasurers.** They see payments, reports and contact details, but no medical information. They can't invite people or link children to accounts.
- **Parents.** They see only their own children. One parent can have several children.

## How it fits together

- **The browser only ever talks to your app**, never to Supabase directly. It holds one thing: a random session id in a secure cookie that scripts can't read.
- **Supabase Auth** keeps the passwords and authenticator-app secrets, and checks them. The app keeps its own session list on top, so staff are signed out after 30 idle minutes and switching someone off takes effect instantly.
- **The database** lives in Supabase, in its own `app` schema that Supabase's public API doesn't expose. Every table is also locked against Supabase's public keys. Children's contact and medical details are encrypted by the app before they're stored.
- **Email** (invites, password resets, sign-up confirmations) is sent by the app through Resend or Postmark, not by Supabase.

## Setting it up

You'll need accounts with GitHub, Supabase (Pro), Vercel (Pro), Resend or Postmark, and Stripe. Set things up in this order.

### 1. Supabase

1. Create a project (Pro for real use; Free is fine for testing), region **Sydney (ap-southeast-2)**, with a strong database password (save it in your password manager).
2. **Database tables:** nothing to do. The app creates its tables the first time it runs, and applies later updates by itself. (If you prefer, you can still run the files in `supabase/migrations/` in the SQL Editor, in order.)
3. **Authentication → Sign In / Providers:** turn **off** "Allow new users to sign up". The app creates every account itself, so nobody can sign up around it. Leave the Email provider on.
4. **Authentication → Rate Limits:** turn **on IP address forwarding**. Without it, Supabase counts every sign-in as coming from your app's server, and its limits would throttle everyone at once.
5. **Authentication → Multi-Factor:** check that **TOTP (App Authenticator)** is enabled.
6. **Authentication → Passwords:** set the minimum length to **12** and turn on **leaked password protection**.
7. **Authentication → Sessions** (optional): turn on "time-box user sessions" at 30 days. This tidies up sign-ins that were started but never finished.
8. **Project Settings → API Keys:** create a **secret key** (it starts with `sb_secret_`). This is `SUPABASE_SECRET_KEY`. The legacy `service_role` key won't work. Copy the **Project URL** as `SUPABASE_URL`.
9. **Connect** (top of the dashboard) → **Transaction pooler**: copy the connection string (port **6543**), put your database password in it, and use it as `DATABASE_URL`.
10. **Database → Backups:** Pro keeps daily backups for 7 days. Consider the Point-in-Time Recovery add-on once real clubs join.

Supabase's own email settings don't matter here, because the app sends its own emails.

### 2. Email (Resend or Postmark)

Add and verify your domain, then create an API key. Set `RESEND_API_KEY` (or `POSTMARK_TOKEN`) and `EMAIL_FROM`, e.g. `Club App <noreply@yourdomain.co.nz>`. The app won't start in production without email, because sign-in links only ever travel by email.

### 3. GitHub and Vercel

1. The code goes in a **private** GitHub repository.
2. In Vercel (Pro for real use; Hobby for testing), choose **Add New → Project** and import the repository. Vercel detects Next.js; leave the build settings as they are.
3. Before the first deploy, open **Environment Variables** and add everything from `.env.example`:
   - Run `npm run gen-key` on any computer with Node, or ask me, to get `APP_ENCRYPTION_KEY`, `CRON_SECRET` and `OWNER_SETUP_SECRET`.
   - **Save `APP_ENCRYPTION_KEY` in your password manager.** If it's lost, children's contact and medical details can't be recovered.
   - Set `APP_URL` to the address people will use, e.g. `https://app.yourdomain.co.nz`.
4. **Deploy.** Then add your domain under **Settings → Domains**. If `APP_URL` changed, update it and redeploy.
5. `vercel.json` already runs the app in Sydney (next to the database) and sets up the daily clean-up (3am NZ time).

### 4. Your owner account

1. Open `https://your-address/#/setup`.
2. Enter the `OWNER_SETUP_SECRET` value, your name and email. You'll get an email to choose your password, then you'll set up two-step verification.
3. **Delete `OWNER_SETUP_SECRET` from Vercel** and redeploy. Set-up also closes by itself once an owner exists.

### 5. Stripe

1. Create a Stripe account for your business, set to New Zealand. Start in **test mode**.
2. **Turn on Connect** (Dashboard → Connect → Get started) and choose **Express** accounts for clubs.
3. **Customer portal:** Settings → Billing → Customer portal. Turn on updating payment methods and cancelling.
4. **Webhooks:** add two endpoints, both pointing at `https://your-address/api/webhook`:
   - **Your account** events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.voided`, `invoice.payment_failed`. Its signing secret goes in `STRIPE_WEBHOOK_SECRET`.
   - **Connected accounts** events: `account.updated`, `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`. Its signing secret goes in `STRIPE_CONNECT_WEBHOOK_SECRET`.
5. Put your secret key in `STRIPE_SECRET_KEY` and redeploy. Test with card `4242 4242 4242 4242`. Switch to live keys once Stripe has verified your business.

## How a club joins

1. On the sign-in page, someone taps **Create your club** and enters the club name, sport, their name and email.
2. They get an email to **confirm their address and choose a password**, then set up two-step verification.
3. The club opens in **preview**: every screen works with sample data in the club's own name, words and colour, but nothing real can be added.
4. A coach taps **Subscribe** in Settings and pays on Stripe's page. The club unlocks straight away.
5. If the subscription ends, the club becomes look-only again. Their data is kept.

Unconfirmed sign-ups are removed after 7 days by the daily clean-up.

## How the money works

- **Clubs pay you** a monthly fee into your Stripe account (Stripe's fee comes out of what you receive, so clubs pay exactly your price): **$49 NZD** by default (`PLATFORM_PRICE_NZD`), or a price you set for that club.
- **Parents pay their club:** a coach taps **Connect Stripe** in Settings so the club gets its own Stripe account. Parents pay by card through your platform's Stripe account, and the **full amount** is passed straight on to the club's account; Stripe's fee comes out of *your* balance, not the club's. The club's name appears on the parent's card statement. If you don't want to pay those fees either, clubs can simply not connect Stripe and take bank transfers.
- **Set-up fees:** set one per club (or a default for every new club with `PLATFORM_SETUP_FEE_NZD`). It's added once to the club's first subscription payment. For a club you've given free access, it's sent as a payment request straight away.
- **How clubs pay you** (Owner Console → **Payment details**): card through Stripe, bank transfer, or both.
  - **Card:** needs Stripe. Charges are marked paid automatically, and Stripe pays the money into the bank account you gave Stripe.
  - **Bank transfer:** works without Stripe and has no fees. You enter your account name and number once. Each request shows them with a reference (like `INV00012`), and you tap **Mark paid** when the money arrives.
- **Charge a club any time:** in the Owner Console, open a club's **Price & charges**, enter an amount and what it's for, and tap **Send payment request**. The club's coaches get an email with the ways to pay (14 days to pay), and it shows in their Settings. You can mark it paid, or cancel it until it's paid.
- **Changing a paying club's price** moves their subscription to the new price from their next bill, with no extra charge for the change itself.
- **Parents pay their club** through Stripe Connect, into the club's own Stripe account. A coach taps **Connect Stripe** in Settings. That money never passes through your account.

## Day-to-day admin

**Inside a club (Settings → Team & Family Access):**
- **Invite people (coaches only):** parents, the treasurer and other coaches. Tick every child a parent should see. Invite links work for 3 days.
- **Lost phone:** the person uses one of their recovery codes. That removes the old phone, and staff add their new phone straight away. Or a coach taps "Lost phone: reset 2-step".
- **Forgotten password:** "Forgot password" on the sign-in page, or staff tap "Email a password reset". The link goes only to that person and works for 1 hour.
- **Someone leaves:** "Switch off" signs them out everywhere. "Delete account" then removes them for good.
- **A member leaves the club:** open them on the Athletes tab and tap the bin twice.

**For you (Owner Console):** give free access, put a club back to normal, switch it off, set up a club for someone (with its own price and set-up fee), set a club's price, charge a club, or delete a club (type its name to confirm).

## Using it on a phone

The app fills the whole screen on phones, tablets and computers. On a computer it has a side menu; on a phone, a bar along the bottom.

To get it on a phone's home screen, where it opens full screen like a normal app with no browser bars:
- **iPhone:** open the app in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open it in Chrome, tap **⋮**, then **Add to Home screen** (or **Install app**).

**Changing your email** (anyone, including you): Settings → Your Account (or My account in the Owner Console) → **Change email**. You enter your password, and the new address gets a link to confirm; the email only changes once that link is opened. The old address is told, too. The address the app's emails come *from* is separate: that's `EMAIL_FROM` in Vercel. To send from your business domain, verify the domain in Resend first.

**Known limit:** one email address belongs to one club. A parent with children in two clubs needs a different email for the second.

## Working on it locally

You need Node 20.9 or newer.

```bash
npm install
cp .env.example .env.local   # fill in a Supabase project (a separate test project is best)
npm run dev                  # http://localhost:3000
```

Without email set up locally, sign-in links are printed in the terminal.

**Tests** need a local Postgres (the tests create and delete their own throwaway databases). Set `TEST_DATABASE_URL` if yours isn't at `postgres://postgres@127.0.0.1:54329/postgres`, then run `npm test`. They use the real database schema, with stand-ins for Supabase Auth and Stripe.

## Legal and privacy (before real families join)

- Terms of service for clubs.
- A privacy policy that meets the NZ Privacy Act 2020.
- A short data processing agreement with each club.
- Ask your accountant about charging GST on subscriptions.
- See `SECURITY.md` for the security review and what's left to do.
