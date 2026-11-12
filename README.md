# Blind Budget Coach

A budgeting coach that never sees your line items. Drop a bank statement CSV into the page; each transaction is categorized on your device by Chrome's built-in Gemini Nano (Prompt API). Transaction details are never uploaded.

Built for the Firebase #BuildHybridAI hackathon (hybrid on-device + cloud inference). This repository is a work in progress: the cloud half is not wired yet.

## What works today

- CSV import with column guessing (date, description, amount) and manual override.
- Per-transaction categorization on device through the Prompt API, with merchant-string cleanup, de-duplicated caching, one transaction per request and enum-constrained output.
- Local keyword-rule fallback when the on-device model is unavailable (labelled in the UI; nothing is uploaded).
- A counter ("N classified on this device · 0 bytes sent"), a per-call timeline, and spending totals by category.
- A routing function that decides where each task may run, based on data sensitivity, model availability, connectivity and consent.

## Routing table

| Task | Data level | Mode | If unavailable |
|---|---|---|---|
| Classify your own transactions | user detail | `ONLY_ON_DEVICE` | local keyword rules, never cloud |
| Classify the bundled sample | public synthetic | `PREFER_ON_DEVICE` | cloud (planned) |
| Blind analysis (question + column schema) | schema only | `PREFER_IN_CLOUD` | fixed query patterns on device |
| Budget advice from category ratios | aggregate you approve | `ONLY_IN_CLOUD` | disabled |

## Run it

```
npm install
npm run dev
npx vitest run
npm run build
```

The Prompt API needs a recent desktop Chrome with the built-in AI model available (first use downloads about 4 GB) and a secure context (`localhost` counts). Model creation requires a user gesture, so classification starts from a button click.

## Privacy notes

- Sample statements in `public/samples/` are synthetic and use fictional merchants.
- `src/firebase.ts` is an empty placeholder; no keys are stored in this repository.
