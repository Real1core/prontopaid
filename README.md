# Quotes & Invoices

A mobile-friendly web app, in the style of Joist, for contractors and vendors to make quotes and invoices: write a quote on the spot, send it, let the customer approve it online, turn it into an invoice and record the payments.

## What it does

- **First run:** the first person to open the app enters the business name and their own name, email and password, and becomes its administrator.
- **Team:** administrators add people on the **Team** tab with an email and starting password, make them administrators or members, reset passwords and turn accounts off. Members see the quotes and invoices they make; administrators see everyone's. Everyone can change their own password from the account menu. After 5 wrong passwords, an email is locked for 15 minutes.
- **Customers:** clients, property owners, property managers, contractors, vendors or anyone else, with their email, phone and billing address. Customers with quotes or invoices can't be deleted, only archived, so those keep their name.
- **Items** have a name, description, quantity, unit (each, hour, sq ft…), price and whether they're taxable. Type them in, or add them from the **price list**: saved items you charge for often. Any line can be saved to the price list.
- **Totals:** a discount ($ or %), sales tax on the taxable items (the discount comes off taxed and untaxed items in proportion), and for quotes an optional deposit due on approval. Amounts are kept in cents, so everything adds up to the penny.
- **PDF** for every quote and invoice, with your logo, company details, the items and totals. Quotes have a signature line and a link to approve online. Unpaid invoices show your "How to pay" instructions. PDFs are stamped PAID, VOID, APPROVED or DECLINED.
- **Sending:** **Send** emails the PDF with a button to view it online (needs email set up, below). Replies go to whoever sent it. Without email, **Copy customer link** or **Download** the PDF and send it by text or your own email. Either way it's marked as sent.
- **The customer's link** (`/#/view/…`) needs no sign-in. It shows the quote or invoice and its PDF. For a quote, the customer types their name and ticks a box to **approve** it, or **declines** it with an optional reason. Whoever made the quote gets an email either way, and the app shows when the link was first opened. Drafts and deleted quotes or invoices can't be opened from the link.
- **Statuses.** Quotes: Draft, Sent, Viewed, Approved, Declined, Expired (past "valid until"), Invoiced. Invoices: Draft, Sent, Viewed, Partly paid, Paid, Overdue, Void. **More** records a status by hand (approved over the phone, declined, void, back to draft). It also duplicates or deletes a quote or invoice.
- **Make invoice** copies a quote's customer, job and items into a new invoice. **Record payment** logs each check, cash, card, ACH or Zelle payment with its date and reference. The balance and status update by themselves.
- The top of the main page totals **unpaid** and **overdue** invoices, **quotes awaiting approval** and **approved quotes not yet invoiced**.
- **Company** tab (administrators): the logo; the name, address, phone, email, website and license number printed on every quote and invoice; the default tax rate, how long quotes stay valid, when invoices are due, the deposit, the number prefixes and next numbers (`Q-1001`, `INV-1001`), the default terms and the "How to pay" instructions.
- Not included: taking card payments online. Payments are recorded by hand.

## Try it locally

Requires Node.js 20 or newer.

```bash
npm install
npm run seed      # optional: sample customers and price list items
npm start         # http://localhost:3000
```

Open the app and set up your business. Data is kept in `data/` (the SQLite database `quotes.db` and the logo); back that folder up.

Run the tests with `npm test`.

## Settings

Copy `.env.example` to `.env`. Everything is optional:

| Setting | What it's for |
| --- | --- |
| `BASE_URL` | The app's public address, used in links sent to customers. Blank: the address it was opened at. |
| `SESSION_SECRET` | Signs sign-in cookies. Blank: one is made and kept in `DATA_DIR`. |
| `DATA_DIR` | Where the database and logo are kept (default `./data`). |
| `APP_TIMEZONE` | Time zone for quote and invoice dates. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Email for sending quotes and invoices and for approval notices. Works with Microsoft 365 (`smtp.office365.com`, 587, with SMTP AUTH turned on for the mailbox), Google Workspace (`smtp.gmail.com`, 587, with an app password) or any SMTP service. |

## Hosting

It's a single Node.js app with a SQLite database, so any host that runs Node and keeps a folder between restarts works (Azure App Service, Render, Railway, Fly.io, a small VPS). Put it behind HTTPS and set `BASE_URL` to the `https://` address, so sign-in cookies are marked secure and customer links are right.
