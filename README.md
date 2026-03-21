# message-chunker

Safe preparation module for splitting long rich-text (Markdown) messages for delivery through transports with message length limits (Telegram, etc.).

**Pipeline:** `markdown → parser → normalized IR → planner → renderer → typed chunks`

## Features

- Markdown parsing via markdown-it, normalization to a compact IR
- Two rendering modes: **rich-html** (safe subset: `<b>`, `<i>`, `<code>`, `<pre>`, `<a>`; code blocks preserve language info via `class="language-*"`) and **plain-text**
- 5-level strategy escalation: `preserve → split-blocks → split-blocks-soft → plain-text → forced-plain-text`
- Greedy packing (maximal prefix per chunk)
- Budget is checked against the **final rendered content** (`content.length`); in `rich-html` this includes HTML escaping/markup overhead
- Unicode-safe splitting (never breaks surrogate pairs)
- `replanTail()` for replanning undelivered tail after transport reject
- Deterministic: same input + same transport profile = same plan
- No network requests, no transport SDK dependency

## Installation

```bash
npm install message-chunker
```

Requires Node.js >= 18.

This package is **ESM-only**. Use `import` / `export`, not CommonJS `require()`.

## Quick start

```js
import { planDelivery } from 'message-chunker';

const plan = planDelivery({
    markdown: '# Hello\n\nThis is a **long** message...',
    preferredMode: 'auto',       // 'auto' | 'rich-html' | 'plain-text'
    strategy: 'preserve',         // starting strategy
    transport: {
        maxTextLength: 4096,
        safeTextBudget: 3600,
        supportsPlainText: true,
        supportsMultipartPlainText: true,
        supportsRichHtml: true,
        countMethod: 'string-length',
    },
});

for (const chunk of plan.chunks) {
    console.log(`[${chunk.index + 1}/${chunk.total}] (${chunk.mode})`);
    console.log(chunk.content);
}

console.log('Strategy used:', plan.diagnostics.usedStrategy);
console.log('Mode used:', plan.diagnostics.usedMode);
console.log('Had forced split:', plan.diagnostics.hadForcedSplit);
```

Within a single `DeliveryPlan`, `usedStrategy` and `usedMode` apply to the whole plan. Mixed rich-html/plain-text delivery is possible only across separate plans, for example: original plan in `rich-html` + replanned tail in `plain-text`.

## Replanning after reject

```js
import { planDelivery, replanTail, nextStrategy } from 'message-chunker';

const markdown = '...';
const transport = { /* ... */ };

const plan = planDelivery({ markdown, preferredMode: 'auto', strategy: 'preserve', transport });

// Send chunks sequentially...
// If chunk i is rejected by the transport:
const tail = replanTail({
    markdown,
    previousPlan: plan,
    failedChunkIndex: 2,          // chunk 2 failed
    preferredMode: 'auto',
    nextStrategy: nextStrategy(plan.diagnostics.usedStrategy) || 'forced-plain-text',
    transport,
    rejectReason: 'too-long',     // 'too-long' | 'invalid-markup'
});

// tail.chunks has fresh indices 0..M-1
// Chunks 0..1 from the original plan are considered delivered
```

`replanTail()` returns a new, separate plan for the undelivered tail. It may use a different `usedStrategy` and `usedMode` from the original plan. This is how mixed-format delivery is supported when, for example, the original rich-html chunk is rejected as `invalid-markup`.

## API

### `planDelivery(request): DeliveryPlan`

Build a delivery plan for a Markdown message.

**PlanRequest:**

| Field | Type | Description |
|---|---|---|
| `markdown` | `string` | Source Markdown text |
| `preferredMode` | `'auto' \| 'rich-html' \| 'plain-text'` | Rendering mode preference |
| `strategy` | `SplitStrategy` | Starting strategy |
| `transport` | `TransportProfile` | Transport capabilities |

**DeliveryPlan:**

| Field | Type | Description |
|---|---|---|
| `chunks` | `PlannedChunk[]` | Ordered chunks ready for delivery |
| `diagnostics` | `PlanDiagnostics` | Detailed diagnostic information |

### `PlanDiagnostics`

| Field | Type | Description |
|---|---|---|
| `sourceLength` | `number` | Source markdown length |
| `plainTextLengthEstimate` | `number` | Plain-text length estimate after normalization/rendering |
| `normalizedBlockCount` | `number` | Number of top-level blocks after normalization |
| `chunkCount` | `number` | Number of chunks in the plan |
| `requestedStrategy` | `SplitStrategy` | Strategy requested by the caller |
| `usedStrategy` | `SplitStrategy` | First strategy that produced a valid plan |
| `requestedMode` | `'auto' \| 'rich-html' \| 'plain-text'` | Mode preference requested by the caller |
| `usedMode` | `'rich-html' \| 'plain-text'` | Rendering mode actually used for this plan |
| `hadDegradation` | `boolean` | `true` if strategy/mode had to degrade or unsupported markdown was simplified |
| `degradedToPlainText` | `boolean` | `true` if planning ended up in plain-text after a non-plain-text preference |
| `hadForcedSplit` | `boolean` | `true` if at least one actual chunk boundary in this plan used forced Unicode-safe split |
| `splitBlockTypes` | `string[]` | Unique block types that actually had to be split |

### `replanTail(request): ReplannedTail`

Replan the undelivered tail after a transport reject.

### `PlannedChunk`

| Field | Type | Description |
|---|---|---|
| `index` | `number` | 0-based index in the plan |
| `total` | `number` | Total number of chunks |
| `mode` | `'rich-html' \| 'plain-text'` | Rendering mode used |
| `content` | `string` | Rendered chunk content |
| `estimatedLength` | `number` | `content.length` |
| `sourceRange` | `SourceRange` | Opaque reference into normalized IR |

### `TransportProfile`

| Field | Type | Description |
|---|---|---|
| `maxTextLength` | `number` | Hard transport limit |
| `safeTextBudget` | `number` | Safe budget (>= 200, must not exceed `maxTextLength`), checked against the final rendered chunk content |
| `supportsPlainText` | `boolean` | Transport accepts plain text |
| `supportsMultipartPlainText` | `boolean` | Transport accepts multiple plain-text messages |
| `supportsRichHtml` | `boolean` | Transport accepts rich HTML |
| `countMethod` | `'string-length'` | Length counting method |

### Helpers

- `STRATEGY_LADDER` — array of all strategies in escalation order
- `nextStrategy(strategy)` — returns the next more aggressive strategy, or `null`
- `isAtLeastAsAggressive(a, b)` — compares two strategies
- `validateTransportProfile(tp)` — throws on invalid profile

## Strategy escalation

| Strategy | Description |
|---|---|
| `preserve` | Keep as single chunk if it fits |
| `split-blocks` | Split at block boundaries (paragraphs, headings, etc.) |
| `split-blocks-soft` | Split within blocks (sentences, punctuation) |
| `plain-text` | Same as split-blocks-soft but in plain-text mode |
| `forced-plain-text` | Last resort: split at `\n\n` → `\n` → whitespace → Unicode-safe forced cut |

## Planning semantics

- Splitting is based on the **maximal prefix that fits the budget**, not on a balanced split.
- For `rich-html`, fit is checked after the final render/escape step, so HTML overhead can move the split point left compared with plain text.
- Within that fitting prefix, the planner prefers softer boundaries according to the current block rule.
- Forced Unicode-safe split is used only when no softer allowed boundary exists inside the fitting prefix.

## Reject handling scenarios

The library provides replanning tools but does **not** hardcode the retry policy — that is the caller's responsibility.

### `too-long` — chunk exceeded the transport limit

Typical caller reaction: lower the budget, raise the strategy, or both.

```js
// Transport rejected chunk 1 as too long → lower budget and escalate strategy
const tail = replanTail({
    markdown,
    previousPlan: plan,
    failedChunkIndex: 1,
    preferredMode: 'auto',
    nextStrategy: nextStrategy(plan.diagnostics.usedStrategy) || 'forced-plain-text',
    transport: { ...transport, safeTextBudget: transport.safeTextBudget - 400 },
    rejectReason: 'too-long',
});
```

### `invalid-markup` — transport rejected the markup

Typical caller reaction: switch to plain-text mode for the remaining tail.

```js
// Transport rejected rich-html chunk → replan tail as plain-text
const tail = replanTail({
    markdown,
    previousPlan: plan,
    failedChunkIndex: 2,
    preferredMode: 'plain-text',
    nextStrategy: plan.diagnostics.usedStrategy,
    transport,
    rejectReason: 'invalid-markup',
});
```

This may produce a mixed final delivery:

- already delivered prefix stays `rich-html`;
- replanned tail goes as `plain-text`.

That mixed result is expected and supported.

### Other transport errors (401, 429, 5xx, network failures)

These are **not** module-level reject reasons. The integration layer must decide whether to retry sending, abort, or map the error to `too-long` / `invalid-markup` before calling `replanTail()`.

## Limitations

- Underscore emphasis (`_text_`, `__text__`) is intentionally not supported — treated as literal text
- Tables are not supported — they fall through as text paragraphs
- Images become text: `alt (src)`
- Raw HTML is escaped in rich-html mode, kept literal in plain-text
- Unicode splitting is surrogate-pair safe but not grapheme-cluster safe (ZWJ sequences may be split)

## Testing

```bash
npm test
```

## Development

```bash
npm install
npm test
npm run pack:check
```

## License

MIT
