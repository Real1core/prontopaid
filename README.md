# ProntoPaid

*Cotice. Facture. Cobre pronto.* (Quote. Invoice. Get paid fast.)

A mobile-friendly web app, in the style of Joist, for contractors and vendors: write a quote on the spot, send it, let the customer approve it online, turn it into an invoice, and get paid by card, bank transfer or customer financing. Premium adds a landing page that brings in new leads. Every screen, PDF and email is in **English and Spanish**.

## What it does

### For businesses
- **Sign up** at the app's address: business name, your name, email and password. Each business has its own customers, price list, quotes, invoices, team, website and payments; no business can see another's.
- **Team:** administrators add people on the **Team** tab and choose their role. Members see the quotes and invoices they make; administrators see everyone's and manage the company details, website, payments and team. After 5 wrong passwords, an email is locked for 15 minutes.
- **English / Español:** everyone picks their language in the account menu (top right). The choice is saved to their account.
- **Customers** (clients, property owners, property managers, contractors, vendors…) each have a **language**. Their quotes, invoices, PDFs, emails and terms come in it. Spanish and English terms and payment instructions are set on the **Company** tab.
- **Quotes and invoices:** items typed in or picked from the **price list**, with discount ($ or %), sales tax on taxable items and an optional deposit. Amounts are kept in cents. A branded PDF is in the customer's language, with the other language a tap away (**More → PDF in …**). Statuses: Draft, Sent, Viewed, Approved, Declined, Expired, Invoiced; for invoices, Partly paid, Paid, Overdue and Void. **Make invoice** turns an approved quote into an invoice; a deposit paid on the quote counts toward it.
- **Sending:** **Send** emails the PDF with a button to view, approve and pay online (needs email set up). Otherwise, **Copy customer link** or **Download** and send it any way you like.
- **Notifications:** the 🔔 in the top bar lists new leads, approvals and declines, payments received, failed bank payments and financing updates, each in the reader's language. Administrators (and whoever made the quote) also get them by email.

### For customers (no sign-in, English or Spanish)
The link to a quote or invoice has an **English / Español** switch. From it, customers can:
- **approve** a quote by typing their name, or **decline** it with a reason;
- **pay** an invoice, or a quote's deposit, **by card or bank transfer (ACH)** on Stripe's secure page, in their language;
- **pay over time**: check if they qualify for financing in about a minute, without affecting their credit score;
- **download the PDF**.

### Getting paid: connect your bank (Stripe Connect)
On the **Get paid** tab, an administrator taps **Connect your bank** and completes Stripe's own sign-up. Stripe checks the business and takes its bank details there; ProntoPaid never sees the account number. After that:
- customers can pay invoices and deposits online, and the money goes straight to the business's bank, usually in 2 business days;
- card payments are recorded on the invoice at once. Bank transfers show as "on its way" until they clear, and a failed one is reported;
- **Payouts and bank details** opens the business's Stripe dashboard;
- online payments can be turned off per business. Online and financed payments can't be deleted in the app; they're refunded in Stripe or by the lender.

### Customer financing (Wisetack)
On the **Get paid** tab, an administrator turns on **Offer financing to my customers** (with their Wisetack merchant ID). Once a quote is approved, or on an unpaid invoice from $500 to $25,000 (adjustable), the customer sees **Pay over time → See if I qualify** and applies on the lender's page. The app follows the application (started, needs more information, approved, loan accepted, paid by lender, not approved). When the lender pays, the payment is recorded and the business is notified. The app never makes lending decisions.

### Premium: a landing page that brings in leads
On the **Website** tab, a business writes its page in English and Spanish: headline, short description, services, about, button text, phone, email, service area, color and a top photo (and its logo). Publishing needs Premium.
- The page lives at **`/s/<their-address>`**, e.g. `https://app.prontopaid.com/s/ortiz-plumbing`. Visitors switch between English and Spanish at the top, and Spanish-speaking browsers open it in Spanish. Blank text in one language shows the other.
- Its **"Get a free quote"** form makes a **lead**. The lead appears on the **Leads** tab, everyone on the team gets a 🔔 notice, and the administrators get an email. Spam is kept out with a hidden field and a limit of 5 requests per visitor per hour.
- **Make a quote** on a lead adds them as a customer, in the language they used, and starts a quote with their address and service.
- **Upgrade to Premium** goes to Stripe's checkout for the monthly subscription. **Manage subscription** (Company tab) opens Stripe's billing page to change the card or cancel. If Premium ends, the page goes offline, but its content is kept.

## Try it locally

Requires Node.js 20 or newer.

```bash
npm install
npm run seed      # optional: a demo business — sign in as demo@example.com / password123
FINANCING_PROVIDER=test PREMIUM_FOR_ALL=true npm start   # http://localhost:3000
```

With `FINANCING_PROVIDER=test`, a pretend lender lets you walk through financing (approve, accept, pay the business). `PREMIUM_FOR_ALL=true` turns on the website for every business. Online payments need Stripe test keys (below). Data is kept in `data/`; back that folder up.

Run the tests with `npm test`. They cover sign-up and keeping businesses apart, quotes through payment, Stripe Connect, card and bank payments (with signed webhooks), Premium, financing (the test lender and Wisetack), the landing page and leads, and that every piece of text has Spanish.

## Stripe

ProntoPaid is the **platform**; each business is a **connected account** (Express).

1. Create a Stripe account for ProntoPaid and turn on **Connect** (Dashboard → Connect → Get started; choose *Express* accounts, *platform* with *destination charges*). Fill in the platform profile.
2. Under **Settings → Payment methods**, make sure **Cards** and **ACH Direct Debit** (us_bank_account) are on.
3. **Premium:** Products → add "ProntoPaid Premium" with a monthly price; put its id in `STRIPE_PREMIUM_PRICE_ID`. Set up the **customer portal** (Settings → Billing → Customer portal) so businesses can cancel or change cards.
4. **Webhooks** (Developers → Webhooks), both pointing to `https://<your address>/api/webhooks/stripe`:
   - an endpoint for **your account** with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Its signing secret goes in `STRIPE_WEBHOOK_SECRET`;
   - an endpoint for **connected accounts** with `account.updated`. Its signing secret goes in `STRIPE_CONNECT_WEBHOOK_SECRET`.
5. Put the secret key in `STRIPE_SECRET_KEY` (start with the `sk_test_…` key and Stripe's test cards and bank accounts). Set `BASE_URL` to the app's `https://` address.
6. Optional: `PLATFORM_FEE_PERCENT` takes a share of each online payment for ProntoPaid. Stripe's processing fee is paid from the business's share.

## Financing

Financing goes through **Wisetack**, the lender Joist uses. Before it can go live:
1. ProntoPaid signs a **partner agreement** with Wisetack. They provide API access (`WISETACK_API_KEY`, `WISETACK_API_URL`), a callback secret (`WISETACK_WEBHOOK_SECRET`), and an enrollment link for businesses (`WISETACK_SIGNUP_URL`).
2. **Check the integration against Wisetack's partner documentation.** Their API is documented privately for partners, so the request and response fields, statuses and callback signature are kept in one place for this: `WISETACK` in `server/financing.js` and the `/wisetack` webhook in `server/routes/payments.js`. Point Wisetack's callbacks at `https://<your address>/api/webhooks/wisetack`.
3. Set `FINANCING_PROVIDER=wisetack`. Each business enrolls with Wisetack and enters its merchant ID on the **Get paid** tab.

Lending is regulated: the wording customers see ("subject to approval", "doesn't affect your credit score") should be confirmed with Wisetack before launch.

## Settings

Copy `.env.example` to `.env`; every setting is explained there. Without Stripe, payments and Premium show as "not set up yet". Without a financing provider, financing doesn't show. Without SMTP, quotes are sent by link or PDF, and notices only show on the bell.

## Hosting

It's a single Node.js app with a SQLite database, so any host that runs Node and keeps a folder between restarts works (Azure App Service, Render, Railway, Fly.io, a small VPS). Put it behind HTTPS and set `BASE_URL` to that `https://` address. That keeps sign-ins secure, and it makes the links in emails, the Stripe returns and the landing page addresses correct.

## Languages

All text is in `public/i18n.js`, written in English with its Spanish beside it. The same file is used by the server (errors, PDFs, emails, the landing page) and the browser. `npm test` fails if any text the app shows has no Spanish, or if a translation drops a `{placeholder}`.
