# Man and Brothers Cosmetics – shop website

One Node.js app with three parts:

| Area | Who uses it | Address |
|------|-------------|---------|
| Online shop | Customers | `/` |
| Shop counter (point of sale) | Shop staff | `/pos` |
| Owner dashboard | Super admin | `/admin` |

## How the customer flow works
1. Customer adds products to the cart and checks out with name and phone (no account needed).
2. They get an invoice number (e.g. `INV-000012`) and an **invoice PDF** that shows the shop's bank account.
3. They transfer the money, then upload a screenshot of the transfer receipt on their order page.
4. The owner sees the screenshot under **Orders**, checks the bank, and clicks **Confirm payment**.
5. The customer downloads a **receipt PDF** marked PAID and shows it at the shop.
6. Staff open **Order collections**, find the invoice, and click **Mark collected**.

Customers can return to an order later from **Track order** using the invoice number and phone number.

## Shop counter
Staff log in, click products to build a sale, choose cash / transfer / card, and complete the sale. A receipt can be printed or downloaded as PDF. Every counter sale and every confirmed online order feeds the reports.

## Built-in protection against staff cheating
- Staff can only create sales. They cannot edit, delete or void anything, and they cannot see other staff members' sales or the owner pages.
- Every sale gets the next sequential receipt number, the staff member's name and the server time. Gaps or changes are impossible from the staff screens.
- Discounts are blocked for staff unless the owner sets a maximum percentage in Settings. The owner is never limited.
- Only the owner can void a sale, with a reason. Voided sales stay in the records marked VOIDED and the stock goes back.
- **Sales by day** shows cash, transfer and card totals per staff member, so the owner knows exactly how much cash each person must hand over.
- **Activity log** records every sale, confirmation, void, stock change, product edit, login (including failed logins) and setting change, with who and when. It cannot be edited.

## Owner dashboard
- Today / this week / this month / this year totals and a 14-day chart
- Orders list with filters, receipt review, confirm / reject / cancel
- Products, categories, stock adjustments, product photos, low-stock alerts
- Sales reports: daily, weekly, monthly, yearly, by product, by staff, by payment method, CSV export
- Staff accounts (owner/admin vs shop staff), settings (shop name, bank details, notes)

## Database: Supabase
All shop data (products, orders, staff, settings, logins) lives in a Supabase Postgres database. Only uploaded images stay on disk in `DATA_DIR/uploads`.

1. Create a project at https://supabase.com.
2. Open *Project Settings → Database → Connection string* and copy two strings into `.env`:
   - `DATABASE_URL` = the **Transaction pooler** string (port 6543)
   - `DIRECT_URL` = the **Direct connection** string (port 5432)
3. Start the app. It creates its tables, default settings, the first admin account and a sample catalogue on first run.

### Moving an existing SQLite shop into Supabase
If you ran the older version (data in `data/shop.db`), copy everything across once:
```bash
npm run migrate:sqlite            # refuses if Supabase already contains orders
npm run migrate:sqlite -- --replace   # wipe Supabase tables and copy again
```
Keep the `uploads/` folder where it is; image file names are stored in the database and still point to it.

## Run it on your computer
```bash
npm install
npm start
```
Open http://localhost:3000. First login: username `admin`, password `admin123` (or whatever `ADMIN_PASSWORD` is set to). **Change it immediately** under "Change password".

Then go to **Settings** and fill in the bank name, account number and account name. These print on every invoice.

## Put it online
The database is in Supabase, so the host only needs a small **persistent disk** for uploaded photos (`DATA_DIR`). Without one, product photos and receipts are lost on every deploy.

### Render.com (easiest)
1. Push this folder to a GitHub repository.
2. On Render: *New +* → *Blueprint* → pick the repo. `render.yaml` sets up the web service and a 1 GB disk at `/var/data`.
3. In the service's Environment tab, set `DATABASE_URL`, `DIRECT_URL` (from Supabase) and `ADMIN_PASSWORD` (a strong password) before the first start.
4. Open the URL Render gives you, log in, change the password, fill in Settings.

### Railway, Fly.io, a VPS, or Docker
- Set env vars `DATABASE_URL`, `DIRECT_URL`, `SESSION_SECRET` (long random text), `DATA_DIR` (a persistent path for uploads), `PORT`, and `ADMIN_PASSWORD` for the first run.
- Docker: `docker build -t shop . && docker run -p 3000:3000 -v shop-data:/data -e DATABASE_URL=... -e DIRECT_URL=... -e SESSION_SECRET=... shop`

Always serve it over HTTPS (Render/Railway do this automatically) so logins and receipts are private.

## Environment variables
| Name | Purpose |
|------|---------|
| `PORT` | Port to listen on (default 3000) |
| `SESSION_SECRET` | Secret for login cookies. Required in production. |
| `DATABASE_URL` | Supabase pooled connection string (Transaction pooler, port 6543). Required. |
| `DIRECT_URL` | Supabase direct connection string (port 5432), used for creating tables and migrations. Falls back to `DATABASE_URL`. |
| `DATA_DIR` | Folder for `uploads/` (product photos, payment receipts; default `./data`) |
| `ADMIN_PASSWORD` | Password for the first `admin` account, used only when the database is first created |

## Backups
Supabase backs up the database automatically (see *Database → Backups* in the Supabase dashboard). Also copy the `DATA_DIR/uploads` folder now and then for the images.

## Project layout
```
src/server.js        app entry point
src/db.js            Supabase/Postgres connection, schema, default settings, sample products
scripts/migrate-from-sqlite.js  one-time copy of an old shop.db into Supabase
src/orders.js        order creation, confirm / reject / collect logic
src/pdf.js           invoice and receipt PDFs
src/routes/store.js  customer shop
src/routes/pos.js    staff point of sale and collections
src/routes/admin.js  owner dashboard, products, reports, staff, settings
src/views/           page templates (EJS)
public/              CSS and browser cart script
```
