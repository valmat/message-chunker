# Issue proposal: add regression fixtures for split quality and replan behavior

## Summary

The library would benefit from regression fixtures that validate not just chunk counts,
but actual chunk boundaries and replanning behavior for realistic long messages.

This matters because the current README and examples describe useful behavior,
but from integration testing it is still hard to know which behaviors are guaranteed
and protected against regressions.

---

## Motivation

We are evaluating the library for a Telegram bot with AI-generated long answers.
In that scenario we need confidence in two things:

1. split quality under pressure;
2. replanning behavior after transport rejection.

The current examples were useful for exploration, but they also revealed that some cases are
not yet strong enough as regression proofs.

---

## Observations from our example outputs

### A. Split-quality behavior needs explicit regression coverage

From `02-strategy-escalation.output.txt`, we observed a mid-word split in `rich-html` mode.

That means a future fix should not only change the code,
but also introduce a regression fixture that locks in the improved boundary choice.

### B. Replan example should prove an actual change in tail planning

From `04-replan-tail-after-reject.output.txt`, the `too-long` replanning example is
architecturally useful, but the resulting tail is still effectively the same two chunks.

That does not necessarily mean `replanTail()` is wrong.
But it means the example does not strongly prove the behavior we would want to rely on in production:

- strategy escalation causing different chunk boundaries;
- lowered budget causing further splitting;
- invalid-markup causing clear mode degradation to plain-text.

---

## Proposed solution

Add regression fixtures / tests that validate behavior on realistic content.

### Fixture group 1 — paragraph split quality

Cases where:

- a sentence boundary exists before the limit;
- only whitespace exists before the limit;
- no readable boundary exists before the limit;
- rich-html escaping changes rendered length.

Assertions should verify:

- exact chunk text;
- whether the split avoided a mid-word break;
- whether the planner used forced split only as a last resort.

### Fixture group 2 — markup-heavy content

Cases with:

- links;
- inline code;
- strong/emphasis;
- escaped HTML characters such as `&`, `<`, `>`.

Assertions should verify that rendered-length handling does not break boundary selection.

### Fixture group 3 — replan behavior

Cases where:

- `too-long` with a smaller budget actually changes chunk boundaries;
- `invalid-markup` clearly switches the tail to plain-text;
- a failure happens on a chunk that started in the middle of a previously split block.

Assertions should verify:

- chunk count change;
- mode change when expected;
- stable and correct source ranges for the replanned tail.

---

## Why this helps maintainers and adopters

This is not only for downstream integrators.
It also makes the library easier to evolve safely.

If readable-split behavior is improved but not regression-tested,
it is easy for a later refactor to silently reintroduce low-quality boundaries.

If replanning is documented but not validated on realistic fixtures,
adopters will still need to build their own confidence externally.

---

## Suggested acceptance criteria

1. At least one regression test must verify that a `rich-html` paragraph is not split mid-word when whitespace/sentence boundary exists.
2. At least one regression test must include escaped HTML-sensitive text.
3. At least one regression test must verify `replanTail()` on a case where `too-long` changes the resulting tail plan.
4. At least one regression test must verify `replanTail()` on a case where `invalid-markup` changes tail mode to `plain-text`.
5. Regression tests must assert exact chunk contents, not only chunk counts.

---

## Optional documentation follow-up

Once these fixtures exist, selected cases could also be mirrored in README examples.
That would make the expected behavior much easier to understand for new adopters.
