# Personal Finance Analyser

Personal Finance Analyser is a private, on-device personal finance tool for reading
bank and credit-card statement PDFs. It parses transactions, categorises card
spending, reconciles imported statements against their printed balances, and
shows the results in Cards, Accounts, and Overview ledgers.

The application has no backend, account, telemetry, or cloud service. PDFs are
read locally with pdf.js and transaction history is stored in the browser's
IndexedDB. The desktop app serves the local interface over localhost; the PWA
uses a service worker to cache the application shell. Data leaves the device
only when you deliberately export or share it.

## Supported statements

* Scotiabank-style credit-card statement PDFs, including supported NCB variants.
* Scotiabank bank-account PDFs containing a Withdrawals & Deposits ledger and
  Account Summary.
* Jamaica-focused currency handling with JMD as the configured base currency.
  Foreign-currency accounts are parsed, reconciled, and displayed separately;
  they are not mixed into JMD totals.

Other statement layouts are not guaranteed to parse correctly. Always check the
reconciliation result and totals after importing a new statement format.

## Features

* Automatic statement-type detection and PDF text parsing.
* Card categorisation using researched merchant intelligence, personal rules,
  and editable configuration rules.
* Manual category corrections, optional merchant rules, and undo.
* Statement-level reconciliation for card and bank ledgers.
* Search, sorting, month/category/type/amount filters, and monthly insights.
* CSV export and printable reports through the browser print dialog.
* Encrypted, passphrase-protected `.ccah` history export/import with idempotent
  merging across all ledgers.
* Separate JSON export/import for portable, human-editable category rules.
* Desktop statements-folder watching with automatic pickup of new PDFs.
* Installable PWA for supported browsers, including iPhone Home Screen use.
* Light and dark themes.

## Setup

Requirements: Node.js 20 or newer. The project is developed and tested with
Node.js 24.

```bash
npm install
```

The install hook copies the required pdf.js files into `third-party/`. Refresh
that copy later with `npm run vendor`.

Run the local web version:

```bash
npm run web
```

Open `http://localhost:8000` in a supported browser. Run the Electron desktop
version with folder watching with:

```bash
npm start
```

Create desktop installers with `npm run build`; output is written to `dist/`.
The current checkout does not contain the `tests/` directory referenced by the
`npm test` script, so the command currently completes without discovering any
tests.

## Usage

1. Choose **Add statement** and select one or more PDF files. On desktop, PDFs
   can also be dropped onto the application window.
2. Review the detected ledger, imported transactions, totals, and reconciliation
   status. Statements are routed to Cards or Accounts automatically.
3. Use **Watch folder** in the desktop app to monitor a statements directory.
   The web/PWA version uses manual file selection instead.
4. Search, filter, sort, and correct categories as needed. Export CSV or use
   **Print / Save as PDF** for a report.
5. Use **Export encrypted history** for a passphrase-protected backup. Use
   **Export rules** separately when you want to transfer only personal category
   rules. The history passphrase cannot be recovered.

For iPhone, host the project on an HTTPS static host, open it in Safari, and
use **Add to Home Screen**. The local development server is HTTP and is not an
iPhone deployment service. Home Screen installation is recommended for
persistent offline storage because of Safari's storage-clearing behavior for
uninstalled web pages.

## Project structure

```text
application/
  app.js                 Application bootstrap and shared UI orchestration
  read-statements.js     PDF parsing, format detection, and reconciliation
  categorise.js          Merchant and category rule processing
  reporting.js           Insights, CSV, history, and print-report generation
  storage.js             IndexedDB persistence
  accounts-render.js     Bank-account ledger rendering
  cards-render.js        Credit-card ledger rendering
  category-picker.js     Category correction UI
  data-export.js         Export menu orchestration
  manage-data.js         Data deletion and reset UI
  shared-helpers.js      Shared parsing and formatting helpers
interface/
  index.html             Browser/PWA shell
  styles.css             Application styling and themes
  manifest.json          PWA metadata
  service-worker.js      Offline application-shell caching
desktop-app/
  electron-main.cjs      Electron process, localhost server, and folder watch
  electron-preload.cjs   Context-isolated desktop bridge
settings/
  config.json            Editable categories, currency, colours, and thresholds
  category-rules.js      Portable personal-rule helpers
developer-tools/         Vendor-copy and local-server scripts
third-party/             Local pdf.js runtime files
launcher/                Windows launch scripts and logs
```

The main configuration surface is `settings/config.json`. Change application
behavior in the relevant `application/` module and presentation in
`interface/styles.css`. Keep statement parsing changes close to
`application/read-statements.js` and add a representative validation case when
test infrastructure is available.

## Privacy and limitations

This is an offline-first local application, not a synchronised service. Each
device has its own IndexedDB history. Moving data between devices requires a
deliberate encrypted history export/import; category rules are transferred as
separate plain JSON. Exported files can contain financial data and should be
handled accordingly.

The parser is focused on Scotiabank and supported NCB layouts, rather than a
general-purpose statement-import standard. Folder watching and direct file
access are desktop-only. There is no native iOS application, App Store or
TestFlight package, automatic cross-device sync, private-sync service, or cloud
AI feature. Browser use requires a modern engine; Safari 16.4+ and current
Chromium/Electron releases are the supported targets.

## Contributing

There is no separate formal contribution guide yet. For a focused change:

1. Check the existing behavior and keep financial calculations based on the
   original parsed values.
2. Update the relevant module and documentation together when behavior changes.
3. Validate with `npm run web` or `npm start`; do not use real personal
   statements in fixtures or examples.
4. Describe statement formats, privacy implications, and validation performed
   in the pull request. Keep unrelated formatting and generated files out of it.

The project is authored by **chevcodes**. Development has included meaningful AI-assisted implementation and review with GitHub Copilot; final code and project decisions remain the responsibility of the project author and contributors.

Some third-party components included in this project carry their own MIT licence terms, and those licences apply only to those components. The project itself is proprietary; all rights are reserved, and no licence to use, copy, modify, or distribute the code is granted beyond what those third-party terms require.
