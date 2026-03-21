# Issue proposal: rich-html soft split may cut in the middle of a word even when better boundaries exist

## Summary

When a long paragraph is split in `rich-html` mode, the library may cut the chunk in the
middle of a word even though a better boundary exists before the limit
(sentence end, punctuation, or at least whitespace).

For our Telegram + AI-response use-case, this is not just cosmetic:
the fallback delivery still works, but readability degrades noticeably.

---

## Why this matters

Our use-case is a Telegram bot with AI-generated long-form guidance.
In that context the chunker is meant to be a **reliable fallback delivery layer**.

However, if the fallback produces chunks like this:

```text
... поэтому ей приходится дели
ть внутри абзаца.
```

then the transport problem is technically solved, but the user experience is worse than it
needs to be.

For conversational / explanatory content, the chunker should strongly prefer readable
boundaries whenever they exist inside the allowed budget.

---

## Observed behavior

Observed in:

- `tmp-message-chunker-examples/02-strategy-escalation.output.txt`

Relevant excerpt:

```text
Example 02B: single oversized paragraph escalates to split-blocks-soft

chunk 1/2
...
Это один очень длинный абзац для демонстрации split-blocks-soft. Он специально состоит из многих предложений. Библиотека сначала пытается сохранить всё целиком. Потом пытается делить по блокам. Но блок здесь один, поэтому ей приходится дели

chunk 2/2
ть внутри абзаца. Сначала она ищет конец предложения. Потом точку с запятой; потом запятую, а затем пробел...
```

This split happened although earlier readable boundaries clearly existed.

---

## Expected behavior

If a paragraph must be split and there is at least one readable boundary before the budget,
the chunker should prefer the **latest acceptable readable boundary** instead of falling back
to a forced Unicode-safe split.

Expected priority is approximately:

1. sentence end
2. semicolon
3. comma
4. colon (optional but useful)
5. whitespace
6. forced Unicode-safe split

The key expectation is:

> forced Unicode-safe split should only be used when no readable boundary exists within the allowed window.

---

## Isolated reproduction

Example input:

```js
import { planDelivery } from 'message-chunker';

const markdown = [
  'Это один очень длинный абзац для демонстрации split-blocks-soft.',
  'Он специально состоит из многих предложений.',
  'Библиотека сначала пытается сохранить всё целиком.',
  'Потом пытается делить по блокам.',
  'Но блок здесь один, поэтому ей приходится делить внутри абзаца.',
  'Сначала она ищет конец предложения.',
  'Потом точку с запятой; потом запятую, а затем пробел.',
  'И только в самом крайнем случае делает принудительный Unicode-safe разрез.',
].join(' ');

const plan = planDelivery({
  markdown,
  preferredMode: 'auto',
  strategy: 'preserve',
  transport: {
    maxTextLength: 4096,
    safeTextBudget: 240,
    supportsPlainText: true,
    supportsMultipartPlainText: true,
    supportsRichHtml: true,
    countMethod: 'string-length',
  },
});

console.log(plan.chunks.map(c => c.content));
```

Observed result: the first chunk may end in the middle of `делить`.

---

## Probable root cause

From code inspection, this looks like a bug or design bug in the `rich-html` soft-splitting path.

The implementation seems to:

1. compute the maximal prefix that still fits the rendered budget;
2. then try to find a better textual boundary inside that prefix;
3. but in some cases the boundary-search step behaves as if “no split is needed” for that prefix;
4. then the algorithm falls through to a forced split.

So the result is more aggressive than the documented strategy order suggests.

---

## Proposed solution

For `rich-html` paragraph splitting:

1. first determine the largest source-text window that can still fit the rendered budget;
2. inside that window, explicitly search for the **latest readable boundary**;
3. only if none exists, use forced Unicode-safe split.

In practice this likely means separating these two concerns more clearly:

- rendered-length fitting;
- readable-boundary selection.

Possible implementation approaches:

### Option A — fix the current prefix-selection logic

- keep current architecture;
- fix the boundary search so it can return a shorter-but-better split point;
- ensure `rich-html` does not downgrade to forced split when whitespace/sentence boundary exists.

### Option B — explicit “best split point <= budget” search

- render-safe fit calculation gives a maximum source prefix;
- then run a backward scan over source text for readable boundaries;
- choose the latest valid one;
- fall back to forced split only when the scan fails.

---

## Acceptance criteria

1. A long paragraph in `rich-html` mode must not be split mid-word if at least one whitespace boundary exists within the fitting window.
2. If a sentence boundary exists within the fitting window, it should be preferred over whitespace.
3. Forced Unicode-safe split must only happen when no configured readable boundary exists inside the fitting window.
4. A regression test must be added using a paragraph similar to the reproduction above.
5. The regression test must verify chunk content, not just chunk count.

---

## Nice-to-have follow-up

If maintainers agree, the fix could also expose split reason metadata in diagnostics
so that regressions become easier to detect from integration logs.
