# Blind Budget Coach

Blind Budget Coach is a budgeting coach that reads your bank statement CSV in your browser. Each transaction is categorized on your device by Chrome's built-in Gemini Nano. When a question or advice needs a larger model, the app asks Gemini in the cloud, and the text it sends is the text you approve: column names, your question, or category percentages. Before each cloud request, a dialog lists that exact text and its size, and you can compare it with the request in your browser's DevTools Network panel. The dialog also names the traffic that is not part of that text (App Check and reCAPTCHA in a production build).

Built for the Firebase #BuildHybridAI hackathon. All model inference goes through Firebase AI Logic (`firebase/ai`) with hybrid inference. The only direct Chrome API call is `LanguageModel.availability()`, which checks whether the on-device model is present.

Live demo: https://blind-budget-coach.web.app

## Who it is for

People who want quick answers from a bank statement ("How much did I spend on Groceries?") while the statement rows stay in the browser: the text of a cloud request is what the dialog lists, and you can check that in DevTools. The "blind" in the name refers to the cloud model: it writes a query plan for your question without seeing your transactions, and your browser runs that plan on your data.

## How it uses Firebase AI Logic hybrid inference

The app creates its models with `getGenerativeModel` and chooses an `InferenceMode` per task, so each kind of data takes a different path.

| `InferenceMode` | Used for | Where it runs |
|---|---|---|
| `ONLY_ON_DEVICE` | Classifying every transaction; picking one of six fixed query patterns for a question | Chrome's on-device model (Gemini Nano) |
| `PREFER_IN_CLOUD` | Blind analysis: writing a query plan from your question and the column names | Gemini in the cloud, after you approve the outbound text |
| `ONLY_IN_CLOUD` | Budget advice from category percentages | Gemini in the cloud, after you approve the outbound text |
| (none) | No on-device model available: local keyword rules. Also obvious payroll-deposit wording (for example `DIRECT DEP`, `PAYROLL`), which a local rule labels Income before the model is asked | JavaScript in the page |

Classification is hard-wired to `ONLY_ON_DEVICE`, and `src/lib/ai.ts` is the only file that creates models and runs inference (`src/firebase.ts` imports `firebase/ai` only to create the AI instance with `getAI`). The only cloud calls are the query-plan and budget-advice requests below, and both sit behind the approval dialog. No code path sends your transactions to the cloud.

## Routing table

| Task | What the request contains | Mode | If unavailable |
|---|---|---|---|
| Classify your transactions (except payroll-deposit wording, which a local rule decides) | No network request is made by the page | `ONLY_ON_DEVICE` | Local keyword rules |
| Pick a fixed query pattern (you declined to send, offline, or cloud not configured) | No network request is made by the page | `ONLY_ON_DEVICE` | Keyword matching |
| Blind analysis | Instructions, today's date, column names and types, the category list, your question, the response structure | `PREFER_IN_CLOUD` | A fixed query pattern, chosen on device or by keywords |
| Budget advice | Instructions, whole-number percentages per category, the response structure | `ONLY_IN_CLOUD` | Disabled; the reason is shown |

Your question is free text, so anything you type into it is sent if you approve. Read the dialog first.

Budget advice is general. It is based on your spending shares and is not investment, tax or personal financial advice. The page says so next to the Budget advice button.

The cloud is treated as not configured until all six Firebase settings are filled in (see below). In that state the app makes no cloud request and the cloud features are disabled. Everything else keeps working.

## What the page shows you

- Outbound gate: before every cloud request, a dialog lists the exact text that will be sent (instructions, message, response structure) and its size in bytes, next to a list of what is not included. The default focus is "Don't send", and Esc means the same. The byte count covers only the text listed in the dialog; the request itself is larger (headers, JSON wrapping). The dialog also carries a fixed note about traffic that is not part of the listed text: in a production build with a reCAPTCHA site key, the first send loads Google reCAPTCHA through Firebase App Check (see "App Check and reCAPTCHA" below). A development build with a debug token shows a shorter note instead (only an App Check token request, no reCAPTCHA).
- Outbound ledger: every request you approved is listed with the text that was sent. The "bytes sent" counter at the top is the sum of the ledger since the last erase. Like the dialog, it counts only the listed text, not HTTP headers, JSON wrapping or App Check and reCAPTCHA traffic.
- Network allow-list: the cloud column states which hosts the browser lets this page connect to, read from the same source as the policy itself (see "Network allow-list (Content-Security-Policy)" below). In a development build, where no policy is applied, it says so.
- Timeline: every model call and rule run, with the side it ran on (Device, Cloud or Rules), the mode, the duration and the reason. A row decided by the payroll-deposit rule is marked Rules, and the summary under the statement counts it separately from the rows the model classified.
- A route line under the statement names the mode in use and why. The "How each task is routed" panel lists all four paths.
- Corrections: pick another category for any row. The correction applies to every row with the same cleaned merchant string and is reused next time.
- "Erase all local data" clears corrections, timeline, ledger and the last statement (IndexedDB).

## Verify it yourself

1. Open DevTools, go to the Network panel, tick "Preserve log", and clear it.
2. Load a sample (or choose your CSV) and click "Classify on this device". During classification the panel should list only requests to the page's own origin (page files and the sample CSV). The on-device model download is done by Chrome itself and does not appear in the page's Network panel.
3. In the Ask box, send a question. When the cloud is configured, the outbound gate opens first, and no request has been made yet. Choose "Don't send" to see that no request follows and that a fixed pattern answers instead.
4. Ask again and choose Send. The Network panel then shows `generateContent` requests to `firebasevertexai.googleapis.com`. Open the request payload and compare it with the text in the dialog. Expect the payload to be larger than the byte count in the dialog: the count covers only the listed text, and the request also has JSON framing, escaping and headers.
   - In a production build with App Check on reCAPTCHA Enterprise, the first send also shows requests that are not part of the listed text: a script from `www.google.com/recaptcha/enterprise.js`, a script from `www.gstatic.com/recaptcha/releases/...`, a frame from `www.google.com/recaptcha/enterprise/anchor`, requests to `www.google.com/recaptcha/enterprise/` (for example `clr`), and a token exchange at `content-firebaseappcheck.googleapis.com` (`exchangeRecaptchaEnterpriseToken`). The dialog says this in its "Also happens when you send" note.
   - reCAPTCHA reads signals from your browser and device. What it reads and sends is decided by Google's script, so the dialog cannot list it word for word. The app does not give App Check or reCAPTCHA your statement, your transactions or question text beyond what the dialog lists.
   - In `npm run dev` with a debug token, only the App Check token request to `content-firebaseappcheck.googleapis.com` appears, and reCAPTCHA is not loaded.
5. To check the offline path, set the Network panel to "Offline", reload the built app (`npm run preview`) and classify again.

## Network allow-list (Content-Security-Policy)

Production builds carry a Content-Security-Policy that lists where this page may load code from and which hosts its code may connect to. The browser enforces it: a request to a host that is not on the list is blocked and reported in the console.

- Where it lives: `src/csp.ts` defines the policy once. `vite build` injects it into `index.html` as a `<meta http-equiv="Content-Security-Policy">` (see `vite-plugin-csp.ts`), right after `<meta charset>` and before anything that loads a resource. `firebase.json` sends the same policy as a response header for every path, plus `frame-ancestors 'none'` (a meta tag cannot carry that directive). A unit test checks that `firebase.json` matches `src/csp.ts`. The dev server applies no policy (so hot reload keeps working), and the cloud column says that instead of claiming one. `npm run preview` adds the header to the built app, so a local preview runs under both the meta tag and the header, like the deployed site.
- Hosts allowed besides this site:

| Host | Used for | Allowed in |
|---|---|---|
| `https://firebasevertexai.googleapis.com` | Gemini through Firebase AI Logic | `connect-src` |
| `https://content-firebaseappcheck.googleapis.com` | App Check token exchange | `connect-src` |
| `https://www.google.com/recaptcha/` | reCAPTCHA Enterprise script, frames and requests | `script-src`, `frame-src`, `connect-src` |
| `https://www.gstatic.com/recaptcha/` | reCAPTCHA script files | `script-src` |
| `https://recaptcha.google.com/recaptcha/` | reCAPTCHA frames | `frame-src` |

- The policy in full (response header version; the meta version is the same without `frame-ancestors`):

```
default-src 'self'; script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/; connect-src 'self' https://firebasevertexai.googleapis.com https://content-firebaseappcheck.googleapis.com https://www.google.com/recaptcha/; frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/; style-src 'self'; img-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

- No wildcard hosts, no `unsafe-eval`, no `unsafe-inline` for scripts or styles. The reCAPTCHA entries follow Google's reCAPTCHA documentation on CSP. Each host is either called by SDK code in the bundle (`firebasevertexai.googleapis.com`, `content-firebaseappcheck.googleapis.com`, `www.google.com/recaptcha/enterprise.js`) or named in Google's reCAPTCHA documentation on CSP. A search of the built JavaScript found no other host that the page requests.
- How to check it yourself: view the page source of the deployed site and find the `Content-Security-Policy` meta tag, or open DevTools, Network, select the document request and read the `Content-Security-Policy` response header. To see the browser enforce it, type `fetch('https://any-other-host.test/')` in the console; it is refused with a message naming `connect-src`.
- What it does and does not cover: it governs this page's code (scripts, fetch and XHR, frames, images, styles, workers). It does not govern what the browser does by itself, such as Chrome downloading the on-device model or checking for component updates. Inside the allowed hosts it says nothing about what is sent: for example, what Google's reCAPTCHA script sends to `www.google.com/recaptcha/` is decided by that script (see "App Check and reCAPTCHA").
- Tested locally on `npm run preview` (Chrome 157): page load, classification of the 60-row sample on device, the six example questions, offline reload through the service worker, and the PWA manifest and icons all ran with no policy violation in the console. Pressing Send on localhost loads the reCAPTCHA scripts and frame with no violation either (the site key only accepts the real domain, so the token request fails there, as expected). On the deployed site (see "Verification status"), the full App Check and Gemini path ran in two browsers with no violation event and no console error. If a later change makes the console show a violation from reCAPTCHA, the first suspects are `style-src` (reCAPTCHA styling its badge) and `img-src`, which would need a narrow addition.

## Requirements

- Desktop Chrome with the built-in Prompt API and its on-device model. It was tested on Chrome 157 on Windows 11. Other Chrome versions, operating systems and low-spec machines were not tested. See Chrome's documentation on built-in AI for the current hardware and storage requirements.
- The on-device model is about 4 GB. If it is not downloaded yet, pressing Classify does not start the download. The page asks you to choose: download the model (done once by Chrome) and then classify, or classify this time with local keyword rules (no download, no cloud request). "Classify again" offers the choice again. Questions use keyword matching until the model is downloaded. Creating the model needs a user gesture, so the download can only start from the button you press.
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

### App Check and reCAPTCHA

The cloud inference app is created on the first cloud call, after you approve a request. App Check is set up at that moment, and not for on-device classification.

- What this adds to the first send: when `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` is set, the page loads Google reCAPTCHA Enterprise (`www.google.com/recaptcha/`, `www.gstatic.com/recaptcha/`) and exchanges its result for an App Check token at `content-firebaseappcheck.googleapis.com`. reCAPTCHA reads signals from the browser and device to decide whether the visitor is a real person. This traffic is not part of the text the dialog lists, and the dialog says so. This reCAPTCHA path is not exercised by on-device classification, only by an approved cloud request.
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
- `src/csp.ts`: the Content-Security-Policy and its host allow-list, defined once. `vite-plugin-csp.ts` injects it into `index.html` at build time; `firebase.json` carries the same policy as a response header.
- `src/lib/disclosure.ts`: the fixed notes about App Check, reCAPTCHA, byte counts and the policy.
- `src/ui/`: outbound gate dialog and icons. All icons are drawn in this repository.
- `public/samples/`: two synthetic statements (60 and 247 rows) with fictional merchants.

## Verification status

Tested in a real browser (Chrome 157, the dev server or the built preview):

- Classifying the 60-row sample on device (58 rows by the model, 2 payroll-deposit rows by the local rule, shown separately in the summary and the timeline), with zero requests to hosts other than localhost during classification (page-level observation through the Chrome DevTools Protocol; requests made by the browser itself are not visible this way).
- Offline load and classification of the built app, and the six example questions offline.
- Corrections, persistence after a reload, and erase.
- The "model not downloaded" state, simulated by overriding the result of `LanguageModel.availability()` (also for "downloading" and "unavailable"): Classify shows the choice, nothing calls the model before you choose, the rules path is labeled Rules in the route line, the timeline and the summary, asking a question afterwards still does not start a download, and "Classify again" offers the choice again.
- The cloud path against a real Firebase project with App Check (debug token): outbound dialog, approved requests, cached repeat questions, budget advice, offline disable and recovery. 13 free-form question runs (including re-tests after a fix) matched direct computation from the CSV.
- The six fixed patterns chosen by the on-device model, using the six example questions only. After a Chrome restart the first one took about 35 seconds, and the loading note appeared after 3 seconds.
- The layout with no on-device model (simulated by removing the Prompt API), the page at widths from 900 px up, and the keyboard path through the main flow.

Tested on the public URL (https://blind-budget-coach.web.app, 2026-11-13), in an ordinary desktop Chrome with no on-device model, so classification used the local keyword rules (the browser version was not recorded). This is the production reCAPTCHA Enterprise App Check path:

- An earlier build. The page load contacted only its own host. Pressing Send ran the production path and it worked: the reCAPTCHA Enterprise script, the token exchange at `content-firebaseappcheck.googleapis.com`, and `generateContent` at `firebasevertexai.googleapis.com`. Of the six example questions sent to the cloud, five produced an accepted plan on the first attempt. "How much do I spend each month?" was rejected twice by the plan validator and then answered with a fixed pattern. Budget advice worked. After a reload the data was still there, and Erase emptied it.
- The build with the Content-Security-Policy (commit `9ff5ca7`). Both the response headers and the HTML carry the policy. After the second load the service worker had switched to the new version. "How much do I spend each month?" was accepted on the first attempt (2026-01: 2,228.90 over 19 rows, 2026-02: 1,810.24 over 17, 2026-03: 826.62 over 19, on the locally classified data). No Content-Security-Policy violation event and no console error were seen. The outbound dialog lists the App Check and reCAPTCHA note, and the budget advice block shows its boundary note.

Tested on the public URL in a separate Chrome 157 test profile on Windows 11 that has the on-device model and had never opened the site (site data checked and empty before the first load):

- Load. The load event fired after about 0.5 s. Every request went to the site's own origin (page files and the service worker's precache fetches). The page reported "On-device model ready", the service worker registered and activated, and the manifest, the four PNG icons and the favicon returned 200.
- Classification. The 60-row sample took 76.8 s: 58 rows by the on-device model and 2 by the payroll-deposit rule. No request went to another host during classification (page-level observation). By eye, 60 of 60 categories looked reasonable. The spending-by-category chart and the "bytes sent" counter (0) were visible.
- Offline (emulated with the Chrome DevTools Protocol). The page reloaded from the service worker in about 0.13 s and restored the last statement. After Erase, the sample loaded offline, and classification took 79.8 s (58 and 2 again) with no request to another host. The six example questions were answered by fixed patterns chosen by the on-device model, in 2.9 to 4.1 s each, and the numbers matched a direct computation from the CSV on the categories shown on screen. The cloud column said "You are offline. Cloud features are off; everything else works." and "Review what would be sent" was disabled.
- Back online. After going back online and reloading, three cloud requests were sent, each after approval in the dialog: the Groceries question, the monthly question and budget advice. The App Check token exchange returned 200 and each `generateContent` returned 200. Both plans were accepted on the first attempt and matched the CSV (Groceries 978.32 over 14 rows; the monthly totals above). In each request body the instruction text, the message and the response structure were identical to what the dialog listed, and the dialog's byte count (2,472, 2,469 and 786) equalled the UTF-8 length of those three parts. The bodies on the wire were 2,731, 2,728 and 1,011 bytes. Searching each body for every description, amount and date in the CSV found none. A new App Check token exchange was needed only for the first request.
- Reload and erase. After a reload the ledger (3 requests, 5,727 bytes) and the timeline were still there. Erase emptied them, and they stayed empty after another reload.
- Policy and console. `/`, `/sw.js`, `/index.html` and `/assets/...` all carry the `Content-Security-Policy` header. Across the whole round there was no violation event and no console error, apart from one error from a deliberate offline control request. As a control for the collector, a deliberate fetch to a non-resolving host from the page was blocked by `connect-src`, reported as a violation, and made no request.

Covered by unit tests only:

- Debit and Credit split columns and the automatic sign guess (also tried on synthetic files).
- The 45 s cloud timeout, the cap of 10 cloud calls per session, and the retry-then-fallback logic for invalid plans (invalid-plan rejection is covered by 21 cases). The retry-then-fallback path was also seen once on the public URL with an earlier build, as described above; the timeout and the cap were not.
- Batched classification (several merchants per call), which exists in the code but is switched off.

Not tested:

- `PREFER_IN_CLOUD` falling back to the on-device model when the cloud is unreachable, rate limiting (HTTP 429) and API-key errors.
- A real model download started from the choice (only simulated, with a stubbed `create()` that throws), the download progress bar and a failed download, other Chrome versions, the CPU path, low-spec machines.
- The service worker update flow, apart from the one switch to a new version noted above. The production App Check path was exercised from one machine in two browsers, and the token exchange succeeded in both. What a visitor sees when App Check refuses the token exchange (for example because of a low reCAPTCHA score) was not tested on the public URL.

## Known limitations

- Speed. Classifying the 60-row sample (34 distinct cleaned merchant strings) took about 40 to 80 seconds in tests, at about 1.2 to 1.6 seconds per distinct string. The first call after the model starts adds about 15 to 40 seconds. The Firebase AI Logic on-device path creates a new Chrome session for each call and sends the system prompt again each time. When the model has to load again (for example after Chrome restarts), the first fixed-pattern question took about 35 to 40 seconds in tests; if the model has not answered after 3 seconds, the page says that it may be loading again.
- Accuracy. On two synthetic evaluation sets of 300 rows each (about 134 distinct strings each), one-by-one classification scored 95.0% and 94.3%. The sets and the script are not part of this repository. These figures were measured before the payroll-deposit rule was added. A check by eye on the 60-row sample earlier found one wrong row out of 60: a payroll deposit read as a transfer. A local rule now handles payroll-deposit wording. It was written after seeing that miss, so the sample is no longer an independent test. The rule looks at the wording only, not the sign of the amount, and covers `PAYROLL`, `DIRECT DEP`, `DIRECT DEPOSIT`, `SALARY` and `PAYCHECK`. Unknown merchants can be wrong; correct them in the table.
- Fixed patterns. Without the cloud, a question maps to one of six fixed patterns: top categories, spending per month, top merchants, total in one category or at one named merchant, average purchase in one category, and count of purchases above an amount. Anything else answers "no result" and suggests an example question. With the cloud, a question that cannot be answered exactly with the plan fields (for example comparing two periods) is reported as out of scope instead of being approximated.
- Batched classification (several merchants per call) was measured and left off. With five merchants per call it was 2.2 to 3.5 times faster on the two sets but lost 0.7 to 3.0 points of accuracy, so one merchant per call stays the default (`DEFAULT_BATCH_SIZE` in `src/lib/ondevice.ts`).
- Cloud limits. The free tier has rate limits. The app allows 10 cloud calls per browsing session and waits at most 45 seconds for each. After a timeout the SDK call may still be running in the background, and its result is discarded. The "bytes sent" counter counts a failed request too, because it may have been sent. Byte counts are the UTF-8 length of the text listed in the dialog (instructions, message and response structure). They omit HTTP headers, JSON wrapping and App Check and reCAPTCHA traffic, so the requests in the Network panel are larger.
- Local storage. The last statement, corrections, timeline and ledger are kept unencrypted in IndexedDB until you erase them. "Erase all local data" clears those four. The Firebase SDK also keeps its own records in IndexedDB, and Erase does not clear them: an App Check token (`firebase-app-check-database`, created by the first approved send) and a heartbeat record (`firebase-heartbeat-database`). They do not contain your statement. Observed in Chrome 157 on the public URL.
- Your own CSV files. Column guessing and the sign guess were checked on synthetic files only.
- Language. English descriptions only.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.

The sample merchants are fictional; any resemblance to real businesses is coincidental. Chrome, Gemini, Firebase and reCAPTCHA are trademarks of Google LLC. This project is independent and is not affiliated with or endorsed by Google.

<!-- token-lint: off -->
