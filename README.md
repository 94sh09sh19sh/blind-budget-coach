# Blind Budget Coach

A budgeting coach that never sees your line items. Drop a bank statement CSV into the page; each transaction is categorized on your device by Chrome's built-in Gemini Nano. The cloud, when used at all, sees only column names, a question you typed, or category percentages you approve, and the page shows you the exact text before anything is sent. You can verify this yourself in your browser's DevTools Network panel.

Built for the Firebase #BuildHybridAI hackathon. All model inference goes through Firebase AI Logic (`firebase/ai`, hybrid inference with `InferenceMode`). This repository is a work in progress: the cloud half is wired but not yet tested against a live Firebase project.

## What it does

- CSV import with column guessing, manual override, Debit / Credit split columns, and an automatic (switchable) spending-sign guess.
- On-device categorization (`ONLY_ON_DEVICE`) with merchant-string cleanup, de-duplicated caching, enum-constrained output, a timeout and one retry.
- Click any category to correct it; the correction applies to every row with the same cleaned merchant string and is reused next time.
- Local storage in IndexedDB (corrections, timeline, last statement) and an "Erase all local data" button.
- Blind analysis: ask a question in one sentence. A query plan (filter, group, aggregate, sort, top N) is written either by the cloud (`PREFER_IN_CLOUD`, after you approve the exact outgoing text) or by one of six fixed patterns picked on device or by keywords. The plan is validated strictly and executed locally.
- Budget advice (`ONLY_IN_CLOUD`): whole-number category percentages in, three suggestions out, after you approve the exact outgoing text.
- A timeline of every call (task, mode, side, duration, bytes sent, reason) and a counter whose "bytes sent" is the running total of request content bytes of cloud calls.
- Offline: the built page is precached (service worker) and still loads and classifies without a connection.

## Routing table

| Task | Data level | Mode | If unavailable |
|---|---|---|---|
| Classify your own transactions | user detail | `ONLY_ON_DEVICE` | local keyword rules, never cloud |
| Blind analysis (question + column schema) | schema only | `PREFER_IN_CLOUD` | fixed query patterns (on device or keywords) |
| Pick a fixed pattern | question text | `ONLY_ON_DEVICE` | keyword match |
| Budget advice from category ratios | aggregate you approve | `ONLY_IN_CLOUD` | disabled, with the reason shown |

The cloud is treated as not configured while the Firebase settings in `src/firebase.ts` are placeholders; in that state no cloud request is ever made.

## Run it

```
npm install
npm run dev
npx vitest run
npm run build && npm run preview
```

The on-device path needs a recent desktop Chrome with the built-in AI model available (first use downloads about 4 GB) and a secure context (`localhost` counts). Model creation requires a user gesture, so classification starts from a button click.

## Privacy notes

- Sample statements in `public/samples/` are synthetic and use fictional merchants.
- Cloud prompts contain only: your question, column names and types, the category list, today's date (analysis), or category percentages (advice). They contain no row of data and no value computed from rows other than those percentages, which you approve first.
- `src/firebase.ts` holds placeholders only; no keys are stored in this repository.
