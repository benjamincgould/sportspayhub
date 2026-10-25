// Browser walkthrough of the real app screens against the new server code (real Postgres, stand-in
// Supabase Auth), with the strict security policy enforced. Run: node tests/e2e/build-ui.mjs && node tests/e2e/run.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, fakeStripe } from '../helpers.mjs';
import { totpFor } from '../fake-auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire('/home/claude/.npm-global/lib/node_modules/')('playwright');
const PORT = 4466;
const BASE = `http://localhost:${PORT}`;
const PW = 'river teapot violet anchor';
const step = (msg) => console.log(`✓ ${msg}`);
const fail = (msg) => { throw new Error(msg); };

process.env.OWNER_SETUP_SECRET = 'e2e-owner-setup-code-long-enough';
const app = await startServer({ env: { APP_URL: BASE, PLATFORM_NAME: 'TeamDesk' }, staticDir: path.join(here, 'dist'), port: PORT, stripe: fakeStripe() });
const linkFor = async (email) => {
  await app.settle();
  const m = app.mailer.outbox.findLast((x) => x.to === email && /#\/(invite|reset|email)\//.test(x.text));
  return m && m.text.match(/http\S+#\/(?:invite|reset|email)\/[\w-]+/)[0];
};

const browser = await chromium.launch();
const problems = [];
const watch = (page, who) => {
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${who} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
};
async function setUpAuthenticator(page) {
  await page.getByText('Set up two-step verification').first().waitFor();
  const secret = (await page.locator('code').first().innerText()).replace(/\s/g, '');
  await page.fill('#mfa-setup-code', totpFor(secret));
  await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
  await page.locator('ul.font-mono li').first().waitFor();
  const codes = (await page.locator('ul.font-mono li').allInnerTexts());
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Go to the app' }).click();
  return { secret, codes };
}
async function acceptAndSignIn(page, link, email, { staff = true } = {}) {
  await page.goto(link);
  await page.getByRole('button', { name: 'Save password' }).waitFor();
  await page.fill('#set-password', PW);
  await page.fill('#set-confirm', PW);
  await page.getByRole('button', { name: 'Save password' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.fill('#login-email', email);
  await page.fill('#login-password', PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  return staff ? setUpAuthenticator(page) : null;
}

try {
  // ---------- First-time owner set-up ----------
  const ownerPage = await (await browser.newContext()).newPage();
  watch(ownerPage, 'owner');
  await ownerPage.goto(`${BASE}/#/setup`);
  await ownerPage.getByText('Create the owner account').waitFor();
  await ownerPage.fill('#setup-secret', 'wrong code');
  await ownerPage.fill('#setup-name', 'Pat Owner');
  await ownerPage.fill('#setup-email', 'owner@platform.test');
  await ownerPage.getByRole('button', { name: 'Create owner account' }).click();
  await ownerPage.getByText(/set-up code isn't right/).waitFor();
  await ownerPage.fill('#setup-secret', process.env.OWNER_SETUP_SECRET);
  await ownerPage.getByRole('button', { name: 'Create owner account' }).click();
  await ownerPage.getByText(/We've emailed owner@platform.test/).waitFor();
  const owner2fa = await acceptAndSignIn(ownerPage, await linkFor('owner@platform.test'), 'owner@platform.test');
  await ownerPage.getByText('Owner Console').waitFor();
  step('First-time set-up at /#/setup needs the set-up code; the owner then signs in with two-step');

  // ---------- A club signs up ----------
  const coachCtx = await browser.newContext();
  const coach = await coachCtx.newPage();
  watch(coach, 'coach');
  await coach.goto(BASE);
  await coach.getByText('TeamDesk').first().waitFor();
  await coach.getByRole('button', { name: 'Create your club' }).click();
  await coach.fill('#signup-club', 'Riverside Rugby');
  await coach.selectOption('#signup-sport', 'Rugby');
  await coach.fill('#signup-name', 'Dana Fox');
  await coach.fill('#signup-email', 'dana@riverside.test');
  await coach.getByRole('button', { name: 'Create club' }).click();
  await coach.getByText(/Check your email/).waitFor();
  const confirmLink = await linkFor('dana@riverside.test');
  await coach.goto(confirmLink);
  await coach.getByText('Welcome to Riverside Rugby').waitFor();
  const coach2fa = await acceptAndSignIn(coach, confirmLink, 'dana@riverside.test');
  await coach.getByText(/Preview: you're looking at sample data/).waitFor();
  await coach.getByRole('button', { name: 'Players', exact: true }).click();
  await coach.getByText('Leo Parker').first().waitFor();
  step('A club signs up, confirms by email, sets up two-step and previews with sample data');

  const details = coach.locator('form', { hasText: 'Club Details & Look' });
  await coach.getByRole('button', { name: 'Settings' }).click();
  await details.getByLabel('Word for groups').fill('Grade');
  await details.getByRole('radio', { name: 'Teal' }).click();
  await details.getByRole('button', { name: 'Save club details' }).click();
  await coach.getByText('Club details saved').waitFor();
  const brand = await coach.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand-600').trim());
  if (brand !== '13 148 136') fail(`club colour should be teal, got "${brand}"`);
  step('Coach rebrands the club (Grades, teal) in preview');

  // ---------- Owner gives free access ----------
  await ownerPage.reload();
  await ownerPage.getByText('Riverside Rugby').waitFor();
  await ownerPage.locator('div', { hasText: 'Riverside Rugby' }).getByRole('button', { name: 'Give free access' }).last().click();
  await ownerPage.getByText('Riverside Rugby now has free access').waitFor();
  if ((await ownerPage.locator('body').innerText()).includes('Leo Parker')) fail('owner must not see member names');
  step('Owner gives the club free access, without seeing any members');

  // ---------- Owner adds bank details, sets a price and charges the club ----------
  await ownerPage.getByRole('button', { name: 'Payment details' }).click();
  await ownerPage.getByText('How clubs pay you').waitFor();
  await ownerPage.getByLabel(/Bank transfer/).check();
  await ownerPage.getByLabel('Account name').fill('Pat Owner Ltd');
  await ownerPage.getByLabel('Account number').fill('12 3456 0123456 00');
  await ownerPage.getByRole('button', { name: 'Save payment details' }).click();
  await ownerPage.getByText('Payment details saved').waitFor();
  if ((await ownerPage.getByLabel('Account number').inputValue()) !== '12-3456-0123456-00') fail('account number should be tidied');
  await ownerPage.getByRole('button', { name: 'Clubs', exact: true }).click();
  step('Owner saves their bank details in Payment details');
  const clubCard = ownerPage.locator('div.bg-white', { hasText: 'Riverside Rugby' }).first();
  await clubCard.getByRole('button', { name: 'Price & charges' }).click();
  await ownerPage.getByLabel('Monthly price (NZD)').fill('39');
  await ownerPage.getByRole('button', { name: 'Save price' }).click();
  await ownerPage.getByText('Pricing saved').waitFor();
  await ownerPage.getByText('$39.00/month (own price)').waitFor();
  await ownerPage.getByLabel('Amount (NZD)').fill('120');
  await ownerPage.getByLabel("What it's for").fill('Club set-up and training');
  await ownerPage.getByRole('button', { name: 'Send payment request' }).click();
  await ownerPage.getByText(/Payment request for \$120.00 emailed/).waitFor();
  await ownerPage.getByText('Waiting for payment').waitFor();
  const reqMail = await (async () => { await app.settle(); return app.mailer.outbox.findLast((m) => m.to === 'dana@riverside.test' && /Payment request/.test(m.subject)); })();
  if (!reqMail) fail('the coach should be emailed the payment request');
  await ownerPage.screenshot({ path: `${here}/owner-desktop.png` });
  step('Owner sets the club\'s own monthly price and sends a $120 payment request; the coach is emailed');

  await coach.reload();
  await coach.getByRole('button', { name: 'Grades', exact: true }).click();
  await coach.getByRole('button', { name: 'Add Grade' }).click();
  const groupForm = coach.locator('div', { has: coach.getByText('New Grade') }).last();
  const gi = groupForm.locator('input');
  await gi.nth(0).fill('Under 12s');
  for (const n of [5, 6, 7]) await gi.nth(n).fill('20');
  await groupForm.getByRole('button', { name: 'Create Grade' }).click();
  await coach.getByText(/Grade added/).waitFor();
  await coach.getByRole('button', { name: 'Add', exact: true }).click();
  await coach.getByText('Timetable updated').waitFor();
  await coach.getByRole('button', { name: 'Players', exact: true }).click();
  await coach.getByRole('button', { name: 'Add player' }).first().click();
  const pf = coach.locator('div', { has: coach.getByText('New Player') }).last();
  const pi = pf.locator('input');
  await pi.nth(0).fill('Tama Fox');
  await pi.nth(1).fill('Mere Fox');
  await pi.nth(3).fill('mere@riverside.test');
  await pf.getByRole('button', { name: 'Add player' }).click();
  await coach.getByText('Tama Fox added').waitFor();
  await coach.getByRole('button', { name: 'Invite or link parent' }).click();
  await coach.getByRole('button', { name: 'Send invite', exact: true }).click();
  await coach.getByText(/We've emailed mere@riverside.test their invite/).waitFor();
  if (await coach.locator('code').filter({ hasText: '#/invite/' }).count()) fail('the invite link must not be shown once emailed');
  step('With access, the coach adds a grade, a timetable, a player, and emails the parent an invite');

  const parent = await (await browser.newContext()).newPage();
  watch(parent, 'parent');
  await acceptAndSignIn(parent, await linkFor('mere@riverside.test'), 'mere@riverside.test', { staff: false });
  await parent.getByText(/Welcome, Mere/).waitFor();
  await parent.getByText('Tama Fox', { exact: true }).first().waitFor();
  await parent.getByText('Under 12s', { exact: true }).first().waitFor();
  step("Parent signs in and sees only their own child, in the club's colours");

  // ---------- The club switches to bank transfer ----------
  await coach.getByRole('button', { name: 'Settings' }).click();
  const methodsCard = coach.locator('form', { hasText: 'How Parents Pay' });
  await methodsCard.getByLabel(/Card, through Stripe/).uncheck();
  await methodsCard.getByLabel(/Bank transfer/).check();
  await methodsCard.getByLabel('Account name').fill('Riverside Rugby Club Inc');
  await methodsCard.getByLabel('Account number').fill('03 1234 0123456 00');
  await methodsCard.getByRole('button', { name: 'Save payment options' }).click();
  await coach.getByText('Payment options saved').waitFor();
  await parent.reload();
  await parent.getByRole('button', { name: 'Payments' }).click();
  await parent.getByRole('heading', { name: 'Pay by bank transfer' }).waitFor();
  await parent.getByText('03-1234-0123456-00').waitFor();
  await parent.getByText(/^FOXF\d+$/).first().waitFor();
  if (await parent.getByRole('button', { name: /card payments/ }).count()) fail('card payments should be hidden when the club only takes bank transfers');
  await parent.screenshot({ path: `${here}/parent-bank.png`, fullPage: true });
  step('Coach switches the club to bank transfer only; the parent sees the account, their family reference and automatic-payment steps');

  await coach.getByRole('button', { name: 'Home' }).click();
  await coach.getByRole('button', { name: 'Record payment' }).first().click();
  await coach.getByLabel(/Amount received from Fox family/).fill('20');
  await coach.getByRole('button', { name: 'Mark paid' }).click();
  await coach.getByText('Fox family marked paid ($20.00)').waitFor();
  await coach.getByText(/last paid/).first().waitFor();
  step('The coach records the bank payment: marked paid, and the income goes in the books');

  await coach.getByRole('button', { name: 'Settings' }).click();
  await coach.locator('form', { hasText: 'How Parents Pay' }).getByLabel(/Card, through Stripe/).check();
  await coach.locator('form', { hasText: 'How Parents Pay' }).getByRole('button', { name: 'Save payment options' }).click();
  await coach.getByText('Payment options saved').waitFor();
  await parent.reload();
  await parent.getByRole('button', { name: 'Payments' }).click();
  await parent.getByText('Your club has set your family to pay by bank transfer.').waitFor();
  await parent.getByRole('heading', { name: 'Pay by bank transfer' }).waitFor();
  if (await parent.getByText(/How will you pay/).count()) fail('parents must not be able to choose card or bank');
  if (await parent.getByRole('button', { name: /card payments/ }).count()) fail('with bank set for this family, the card buttons should be hidden');
  await parent.getByText('Family total').waitFor();
  await coach.getByRole('button', { name: 'Home' }).click();
  await coach.getByLabel('Fox family: how they pay').selectOption('card');
  await coach.getByText('Fox family now pays by card').waitFor();
  await parent.reload();
  await parent.getByRole('button', { name: 'Payments' }).click();
  await parent.getByText(/Your club has set your family to pay by card/).waitFor();
  await parent.getByRole('button', { name: /card payments/ }).waitFor();
  if (await parent.getByRole('heading', { name: 'Pay by bank transfer' }).count()) fail('with card set, the bank details should be hidden');
  await parent.screenshot({ path: `${here}/parent-family.png`, fullPage: true });
  await coach.getByLabel('Fox family: how they pay').selectOption('bank');
  await coach.getByText('Fox family now pays by bank transfer').waitFor();
  step('With both offered, the club (not the parent) sets each family to card or bank; the parent sees one family page');

  // ---------- Session passes ----------
  await coach.getByRole('button', { name: 'Settings' }).click();
  await coach.getByLabel('Sessions per pass').fill('6');
  await coach.getByLabel('Price of a pass').fill('60');
  await coach.getByRole('button', { name: 'Save pass' }).click();
  await coach.getByText('Pass saved: 6 sessions for $60.00').waitFor();
  await coach.getByLabel('Financial year start month').selectOption('7');
  await coach.getByText(/Your year runs 1 July to 30 June/).waitFor();
  await coach.getByRole('button', { name: 'Save settings' }).click();
  await coach.getByText('Settings saved').waitFor();
  await coach.getByRole('button', { name: 'Players', exact: true }).click();
  if (!(await coach.getByRole('button', { name: 'Give a pass' }).count())) await coach.getByRole('button', { name: /Tama Fox/ }).first().click();
  await coach.getByRole('button', { name: 'Give a pass' }).click();
  if (await coach.getByLabel('Number of sessions').inputValue() !== '6') fail('the pass form should start with the club\'s pass');
  await coach.getByLabel('Number of sessions').fill('5');
  await coach.getByLabel('Pass price').fill('55');
  await coach.getByLabel('Paid by').selectOption('cash');
  await coach.getByRole('button', { name: 'Give pass' }).click();
  await coach.getByText('Tama has a 5-session pass').waitFor();
  await coach.getByText('5 of 5 sessions left').waitFor();
  await parent.reload();
  await parent.getByRole('button', { name: 'Payments' }).click();
  await parent.getByText('5 sessions left').waitFor();
  step('The coach sets the club\'s pass (sessions and price) and a 1 July financial year, then gives a player a pass; the parent sees the sessions left');

  await coach.getByRole('button', { name: 'Settings' }).click();
  await coach.getByText('Payments to the App Provider').waitFor();
  await coach.getByRole('button', { name: 'Pay $120.00 by card' }).waitFor();
  await coach.getByText('Or pay by bank transfer').waitFor();
  await coach.getByText('12-3456-0123456-00').waitFor();
  await coach.getByText(/INV\d{5}/).first().waitFor();
  await coach.getByText('Payments to the App Provider').scrollIntoViewIfNeeded();
  await coach.screenshot({ path: `${here}/coach-desktop.png` });
  await coach.setViewportSize({ width: 390, height: 844 });
  await coach.getByRole('button', { name: 'Home' }).click();
  await coach.screenshot({ path: `${here}/coach-phone.png` });
  await coach.setViewportSize({ width: 1280, height: 800 });
  step('The coach sees the payment request with a card button and the owner\'s bank details and reference');

  await ownerPage.getByRole('button', { name: 'Mark paid' }).click();
  await ownerPage.getByRole('button', { name: 'Tap again' }).first().click();
  await ownerPage.getByText('Marked as paid').waitFor();
  await ownerPage.getByText(/paid by bank transfer/).waitFor();
  step('The bank transfer arrives and the owner marks the charge paid');

  // ---------- Owner changes their email ----------
  await ownerPage.getByRole('button', { name: 'My account' }).click();
  await ownerPage.getByRole('button', { name: 'Change email' }).click();
  await ownerPage.fill('#acct-new-email', 'pat@business.test');
  await ownerPage.fill('#acct-email-pw', PW);
  await ownerPage.getByRole('button', { name: 'Send confirmation' }).click();
  await ownerPage.getByText(/emailed pat@business.test a link/).waitFor();
  const emailLink = await linkFor('pat@business.test');
  await ownerPage.goto(emailLink);
  await ownerPage.getByRole('button', { name: 'Confirm new email' }).click();
  await ownerPage.getByText('From now on, sign in with pat@business.test.').waitFor();
  await ownerPage.getByRole('button', { name: 'Back to the app' }).click();
  await ownerPage.getByText('Owner Console').waitFor();
  const check = await (await browser.newContext()).newPage();
  await check.goto(BASE);
  await check.fill('#login-email', 'pat@business.test');
  await check.fill('#login-password', PW);
  await check.getByRole('button', { name: 'Sign in' }).click();
  await check.getByText('Enter your code').waitFor();
  step('Owner changes their email: confirms from the new inbox, then signs in with it');

  // ---------- Lost phone: a recovery code ----------
  await coach.getByLabel('Sign out').click();
  await coach.fill('#login-email', 'dana@riverside.test');
  await coach.fill('#login-password', PW);
  await coach.getByRole('button', { name: 'Sign in' }).click();
  await coach.getByText('Enter your code').waitFor();
  await coach.getByRole('button', { name: /Use a recovery code/ }).click();
  await coach.fill('#mfa-code', coach2fa.codes[0]);
  await coach.getByRole('button', { name: 'Continue' }).click();
  await coach.getByText(/Recovery code accepted/).waitFor();
  await setUpAuthenticator(coach);
  await coach.locator('header').getByText('Riverside Rugby').waitFor();
  step('Coach who lost their phone uses a recovery code, adds the new phone, and is back in');

  // ---------- Security in the browser ----------
  const cookies = await coachCtx.cookies();
  const sessionCookie = cookies.find((c) => c.name === 'club_session');
  if (!sessionCookie?.httpOnly || sessionCookie.sameSite !== 'Strict') fail('session cookie must be HttpOnly + SameSite=Strict');
  if (cookies.some((c) => /^sb-|supabase/i.test(c.name))) fail('no Supabase tokens may reach the browser');
  const stored = await coach.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  if (/eyJ|refresh|access_token/i.test(stored)) fail('no tokens in browser storage');
  step('Only a random HttpOnly session id reaches the browser; no Supabase tokens in cookies or storage');

  const csp = problems.filter((p) => /Content Security Policy|Refused to/.test(p));
  if (csp.length) fail(`CSP violations:\n${csp.join('\n')}`);
  const other = problems.filter((p) => !/Failed to load resource: the server responded with a status of (400|401|402|403|404|409|503)/.test(p));
  if (other.length) fail(`Browser errors:\n${other.join('\n')}`);
  step('No security-policy violations or script errors in the browser');
  void owner2fa;
  console.log('\nBrowser walkthrough passed.');
} catch (err) {
  for (const [i, ctx] of browser.contexts().entries()) for (const [j, pg] of ctx.pages().entries()) await pg.screenshot({ path: `${here}/fail-${i}-${j}.png` }).catch(() => {});
  console.error(`\n✗ ${err.message.split('\n').slice(0, 8).join('\n')}`);
  if (problems.length) console.error(`Browser messages:\n${problems.slice(-10).join('\n')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await app.close();
}
