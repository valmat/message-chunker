# Issue proposal: add readable-boundary policy and split diagnostics for long AI-generated responses

## Summary

The current strategy ladder is a good base for transport safety, but it is still too narrow
for conversational long-form AI output where readability matters almost as much as delivery.

We would like a more explicit and configurable notion of **readable split quality**, plus
better diagnostics explaining how a plan was produced.

---

## Motivation

Our use-case is not generic file chunking or arbitrary text slicing.
It is a Telegram bot that sends AI-generated explanations, recommendations, and guided steps.

In this type of output:

- paragraph integrity matters;
- sentence boundaries matter;
- list-item integrity matters;
- avoiding mid-word splits matters;
- observability matters when fallback delivery is activated.

Right now the library is already useful as a transport fallback layer,
but it does not yet provide enough control or diagnostics for “quality-aware” chunking.

---

## What we observed from the example outputs

From `tmp-message-chunker-examples/*.output.txt` we can currently see:

- `usedStrategy`
- `usedMode`
- `splitBlockTypes`
- chunk content / sourceRange

But we cannot see:

- why a particular chunk boundary was chosen;
- whether a split was sentence-based, punctuation-based, whitespace-based, or forced;
- whether a mid-word split happened;
- whether the planner traded readability for maximal packing.

For production bot behavior, those distinctions are important.

---

## Problem statement

The current planner seems optimized for:

- safe delivery;
- deterministic output;
- maximal prefix packing.

Those are all good goals.

However, for AI-generated user-facing prose, the planner should also support:

- readable boundary preference;
- explainable split reasons;
- configurable tolerance for “one extra chunk in exchange for a better boundary”.

---

## Proposed solution

Introduce a more explicit readable-split policy.

This could be implemented in a minimal or extended form.

### Minimal form

Add planner diagnostics for each boundary decision.

For example, per chunk or per split:

```ts
splitReason:
  | 'preserve'
  | 'block-boundary'
  | 'sentence-boundary'
  | 'semicolon'
  | 'comma'
  | 'colon'
  | 'whitespace'
  | 'forced-unicode-safe'
```

And aggregate booleans such as:

- `hadForcedSplit`
- `hadMidWordSplit`
- `hadReadabilityCompromise`

### Extended form

Allow the caller to choose a chunk-quality policy.

For example:

```ts
readabilityPolicy: {
  preferReadableBoundaries: true,
  avoidMidWordSplit: true,
  preferSentenceBoundaryOverMaxPacking: true,
}
```

or perhaps a simpler top-level option such as:

```ts
splitQuality: 'max-packing' | 'balanced' | 'readable'
```

Possible semantics:

- `max-packing` — current behavior or close to it;
- `balanced` — prefer readable boundary if it is reasonably close to the budget;
- `readable` — prefer sentence / punctuation / whitespace even if it produces more chunks.

---

## Why this is realistic and implementable

This proposal does not require a new parser or a new public architecture.

It can be layered onto the existing planner by:

1. making boundary selection more explicit;
2. capturing split reason metadata;
3. optionally letting the caller bias boundary ranking.

This keeps the current API shape mostly intact while making the library much more useful
for chat / assistant integrations.

---

## Suggested acceptance criteria

1. Diagnostics must expose why each chunk boundary was chosen.
2. Diagnostics must make forced splits observable.
3. Diagnostics must make mid-word splits observable.
4. The planner must support a mode or policy that prefers readable boundaries over maximal packing.
5. In readable-preference mode, the planner may produce more chunks if that avoids mid-word or low-quality splits.
6. The behavior must be covered by regression tests using realistic long-form prose, not only synthetic short strings.

---

## Concrete examples of policies that would help our use-case

For Telegram + AI responses, the following ranking would already be useful:

1. block boundary
2. list item boundary
3. sentence boundary
4. semicolon
5. comma
6. colon
7. whitespace
8. forced Unicode-safe split

And for diagnostics, even this minimal information would already be valuable:

```json
{
  "usedStrategy": "split-blocks-soft",
  "usedMode": "rich-html",
  "hadForcedSplit": false,
  "hadMidWordSplit": false,
  "splitReasons": ["sentence-boundary", "block-boundary"]
}
```

---

## Non-goal

This proposal is not asking for full semantic summarization or LLM-aware rewriting.
It only asks the chunker to expose and improve the split-quality decisions it already makes.
