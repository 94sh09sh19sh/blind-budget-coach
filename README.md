# Blind Budget Coach

Blind Budget Coach is a budgeting coach that reads your bank statement CSV in your browser. Each transaction is categorized on your device by Chrome's built-in Gemini Nano. When a question or advice needs a larger model, the app asks Gemini in the cloud with only the text you approve: column names, your question, or category percentages. Before anything is sent, a dialog lists the exact text and its size, and you can compare it with the request in your browser's DevTools Network panel.

Built for the Firebase #BuildHybridAI hackathon. All model inference goes through Firebase AI Logic (`firebase/ai`) with hybrid inference. The only direct Chrome API call is `LanguageModel.availability()`, which checks whether the on-device model is present.

Live demo: (added after deployment)

## Who it is for

People who want quick answers from a bank statement ("How much did I spend on Groceries?") without uploading the statement itself to a budgeting service. The "blind" in the name refers to the cloud model: it writes a query plan for your question without seeing your transactions, and your browser runs that plan on your data.

## How it uses Firebase AI Logic hybrid inference

The app creates its models with `getGenerativeModel` and chooses an `InferenceMode` per task, so each kind of data takes a different path.

| `InferenceMode` | Used for | Where it runs |
|---|---|---|
| `ONLY_ON_DEVICE` | Classifying every transaction; picking one of six fixed query patterns for a question | Chrome's on-device model (Gemini Nano) |
| `PREFER_IN_CLOUD` | Blind analysis: writing a query plan from your question and the column names | Gemini in the cloud, after you approve the outbound text |
| `ONLY_IN_CLOUD` | Budget advice from category percentages | Gemini in the cloud, after you approve the outbound text |
| (none) | No on-device model available: local keyword rules. Also obvious payroll-deposit wording (for example `DIRECT DEP`, `PAYROLL`), which a local rule labels Income before the model is asked | JavaScript in the page |

Classification is hard-wired to `ONLY_ON_DEVICE`, and `src/lib/ai.ts` is the only file that imports `firebase/ai`. The only cloud calls are the query-plan and budget-advice requests below, and both sit behind the approval dialog. No code path sends your transactions to the cloud.

## Routing table

| Task | What the request contains | Mode | If unavailable |
|---|---|---|---|
| Classify your transactions (except payroll-deposit wording, which a local rule decides) | No network request is made by the page | `ONLY_ON_DEVICE` | Local keyword rules |
| Pick a fixed query pattern (you declined to send, offline, or cloud not configured) | No network request is made by the page | `ONLY_ON_DEVICE` | Keyword matching |
| Blind analysis | Instructions, today's date, column names and types, the category list, your question, the response structure | `PREFER_IN_CLOUD` | A fixed query pattern, chosen on device or by keywords |
| Budget advice | Instructions, whole-number percentages per category, the response structure | `ONLY_IN_CLOUD` | Disabled; the reason is shown |

Your question is free text, so anything you type into it is sent if you approve. Read the dialog first.

The cloud is treated as not configured until all six Firebase settings are filled in (see below). In that state the app makes no cloud request and the cloud features are disabled. Everything else keeps working.

## What the page shows you

- Outbound gate: before every cloud request, a dialog lists the exact text that will be sent (instructions, message, response structure) and its size in bytes, next to a list of what is not included. The default focus is "Don't send", and Esc means the same.
- Outbound ledger: every request you approved is listed with the text that was sent. The "bytes sent" counter at the top is the sum of the ledger since the last erase.
- Timeline: every model call and rule run, with the side it ran on (Device, Cloud or Rules), the mode, the duration and the reason. A row decided by the payroll-deposit rule is marked Rules, and the summary under the statement counts it separately from the rows the model classified.
- A route line under the statement names the mode in use and why. The "How each task is routed" panel lists all four paths.
- Corrections: pick another category for any row. The correction applies to every row with the same cleaned merchant string and is reused next time.
- "Erase all local data" clears corrections, timeline, ledger and the last statement (IndexedDB).

## Verify it yourself

1. Open DevTools, go to the Network panel, tick "Preserve log", and clear it.
2. Load a sample (or choose your CSV) and click "Classify on this device". During classification the panel should list only requests to the page's own origin (page files and the sample CSV). The on-device model download is done by Chrome itself and does not appear in the page's Network panel.
3. In the Ask box, send a question. When the cloud is configured, the outbound gate opens first and nothing has been sent yet. Choose "Don't send" to see that no request follows and that a fixed pattern answers instead.
4. Ask again and choose Send. The Network panel then shows `generateContent` requests to `firebasevertexai.googleapis.com` (plus a token request to `content-firebaseappcheck.googleapis.com` when App Check is on). Open the request payload and compare it with the text in the dialog. Expect the payload to be slightly larger than the byte count in the dialog, because of JSON framing and escaping.
5. To check the offline path, set the Network panel to "Offline", reload the built app (`npm run preview`) and classify again.

## Requirements

- Desktop Chrome with the built-in Prompt API and its on-device model. It was tested on Chrome 157 on Windows 11. Other Chrome versions, operating systems and low-spec machines were not tested. See Chrome's documentation on built-in AI for the current hardware and storage requirements.
- The first use downloads the on-device model (about 4 GB). Creating the model needs a user gesture, so classification starts from a button click.
- English text. The app declares English (`en`) as input and output language for the model, and the samples and category names are English.
- A secure context (`https`, or `localhost` for local runs).
- Without the model, the app still runs. It uses local keyword rules for classification and keyword matching for the six fixed questions.
- Cloud features need a Firebase project (see below). They are optional.

## Run it locally

```
npm install
npm run dev
```

Open `http://localhost:5173`. With no Firebase settings, the app runs on device and with local rules only.

## Connect your own Firebase project

1. Create a Firebase project, register a web app, and enable Firebase AI Logic with the Gemini Developer API.
2. Copy `.env.example` to `.env.development.local` (read by `npm run dev`) and to `.env.production.local` (read by `npm run build`). Both are ignored by git. Fill in the six `VITE_FIREBASE_*` values that the Firebase console shows for your web app.
3. Restart `npm run dev`. The cloud features turn on once all six values are set.
4. The cloud model name is `CLOUD_MODEL` in `src/firebase.ts` (currently `gemini-3.5-flash-lite`).
5. `.firebaserc` names the Firebase project used for Hosting. Run `firebase use --add` to point it at your own project before you deploy.

The `VITE_FIREBASE_*` values identify a project and are not secrets. Restrict the API key and turn on App Check for your project. The debug token described below is a secret.

### App Check

The cloud inference app is created on the first cloud call, after you approve a request. App Check is set up at that moment, and not for on-device classification.

- Production builds: set `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` (a reCAPTCHA Enterprise site key, a public value) in `.env.production.local`.
- Local development: create a debug token in the Firebase console (App Check, Apps, Manage debug tokens) and set `VITE_APPCHECK_DEBUG_TOKEN` in `.env.development.local`. This token is a secret. The code reads it in dev mode only.
- If neither is set, App Check stays off. A project that enforces App Check will then refuse the request, and the app shows a short error instead of the raw message.

## Tests and build

```
npx vitest run
npm run lint
npm run build
npm run preview
```

`npm run build` runs `tsc -b` and `vite build`. The build is a PWA: a service worker precaches the page and the sample CSVs, so the built app also loads offline.

## Project layout

- `src/lib/ai.ts`: Firebase AI Logic calls (on-device model creation, cloud request).
- `src/lib/router.ts`: picks the mode and side for each kind of data.
- `src/lib/ondevice.ts`, `src/lib/normalize.ts`, `src/lib/rules.ts`: on-device classification, merchant-string cleanup, local keyword rules.
- `src/lib/plan.ts`: query-plan structure, strict validator, whitelisted executor, six fixed patterns.
- `src/lib/cloudtasks.ts`: outbound text, blind analysis, budget advice, caching, call limits.
- `src/firebase.ts`: settings from `VITE_` variables, App Check.
- `src/ui/`: outbound gate dialog and icons. All icons are drawn in this repository.
- `public/samples/`: two synthetic statements (60 and 247 rows) with fictional merchants.

## Verification status

Tested in a real browser (Chrome 157, the dev server or the built preview):

- Classifying the 60-row sample on device (58 rows by the model, 2 payroll-deposit rows by the local rule, shown separately in the summary and the timeline), with zero requests to hosts other than localhost during classification (page-level observation through the Chrome DevTools Protocol; requests made by the browser itself are not visible this way).
- Offline load and classification of the built app, and the six example questions offline.
- Corrections, persistence after a reload, and erase.
- The cloud path against a real Firebase project with App Check (debug token): outbound dialog, approved requests, cached repeat questions, budget advice, offline disable and recovery. 13 free-form question runs (including re-tests after a fix) matched direct computation from the CSV.
- The six fixed patterns chosen by the on-device model, using the six example questions only. After a Chrome restart the first one took about 35 seconds, and the loading note appeared after 3 seconds.
- The layout with no on-device model (simulated by removing the Prompt API), the page at widths from 900 px up, and the keyboard path through the main flow.

Covered by unit tests only:

- Debit and Credit split columns and the automatic sign guess (also tried on synthetic files).
- The 45 s cloud timeout, the cap of 10 cloud calls per session, and the retry-then-fallback logic for invalid plans (invalid-plan rejection is covered by 21 cases).
- Batched classification (several merchants per call), which exists in the code but is switched off.

Not tested:

- The production reCAPTCHA Enterprise App Check path (only the debug-token path was exercised).
- `PREFER_IN_CLOUD` falling back to the on-device model when the cloud is unreachable, rate limiting (HTTP 429) and API-key errors.
- The model download progress bar and a failed download (the model was already present), other Chrome versions, the CPU path, low-spec machines.
- The service worker update flow.

## Known limitations

- Speed. Classifying the 60-row sample (34 distinct cleaned merchant strings) took about 45 to 80 seconds in tests, at about 1.2 to 1.6 seconds per distinct string. The first call after the model starts adds about 15 to 30 seconds. The Firebase AI Logic on-device path creates a new Chrome session for each call and sends the system prompt again each time. When the model has to load again (for example after Chrome restarts), the first fixed-pattern question took about 35 to 40 seconds in tests; if the model has not answered after 3 seconds, the page says that it may be loading again.
- Accuracy. On two synthetic evaluation sets of 300 rows each (about 134 distinct strings each), one-by-one classification scored 95.0% and 94.3%. The sets and the script are not part of this repository. These figures were measured before the payroll-deposit rule was added. A check by eye on the 60-row sample earlier found one wrong row out of 60: a payroll deposit read as a transfer. A local rule now handles payroll-deposit wording. It was written after seeing that miss, so the sample is no longer an independent test. The rule looks at the wording only, not the sign of the amount, and covers `PAYROLL`, `DIRECT DEP`, `DIRECT DEPOSIT`, `SALARY` and `PAYCHECK`. Unknown merchants can be wrong; correct them in the table.
- Fixed patterns. Without the cloud, a question maps to one of six fixed patterns: top categories, spending per month, top merchants, total in one category or at one named merchant, average purchase in one category, and count of purchases above an amount. Anything else answers "no result" and suggests an example question. With the cloud, a question that cannot be answered exactly with the plan fields (for example comparing two periods) is reported as out of scope instead of being approximated.
- Batched classification (several merchants per call) was measured and left off. With five merchants per call it was 2.2 to 3.5 times faster on the two sets but lost 0.7 to 3.0 points of accuracy, so one merchant per call stays the default (`DEFAULT_BATCH_SIZE` in `src/lib/ondevice.ts`).
- Cloud limits. The free tier has rate limits. The app allows 10 cloud calls per browsing session and waits at most 45 seconds for each. After a timeout the SDK call may still be running in the background, and its result is discarded. The "bytes sent" counter counts a failed request too, because it may have been sent. Byte counts are the UTF-8 length of instructions, message and response structure, and omit HTTP headers.
- Local storage. The last statement, corrections, timeline and ledger are kept unencrypted in IndexedDB until you erase them.
- Your own CSV files. Column guessing and the sign guess were checked on synthetic files only.
- Language. English descriptions only.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.

The sample merchants are fictional. Chrome, Gemini and Firebase are trademarks of Google LLC. This project is independent and is not affiliated with or endorsed by Google.

<!-- token-lint: off -->
