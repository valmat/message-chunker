# RFC: Safe preparation module for long rich-text messages for delivery

## Status

Approved for implementation

---

## 1. Purpose of the document

This document fixes the requirements for a module that takes markdown-like text, prepares it for delivery through a transport with a message length limit, and returns a delivery plan as an array of typed chunks.

Goals of the module:

- whenever possible, deliver the message whole and with formatting;
- if this is not possible, split the message into parts;
- if rich format does not pass, degrade to plain text;
- if the transport rejects part of the plan, replan only the undelivered tail with a more aggressive strategy.

The document sets the base logic v1, enough to start development.

---

## 2. Context

The system receives text from an LLM in a markdown-like format and must deliver it through an external transport.

The target product scenario is a Telegram-like transport, where:

- one message has a length limit;
- not all Markdown is supported;
- formatting is transferred through a limited HTML subset;
- a message can be rejected by the transport because of:
  - limit exceeded,
  - invalid markup,
  - other transport-level reasons.

A direct approach like:

```text
markdown -> html -> transport
```

is not reliable enough, because:

- the length of the final message is not guaranteed in advance;
- the resulting HTML can be rejected;
- long structural fragments cannot be safely cut like a normal string without losing readability;
- a sending error should not crash the application;
- in partial delivery we must not duplicate what was already sent.

---

## 3. Supported transport profile v1

In the first version the module is focused on transports that meet the following conditions:

1. support delivery of plain text;
2. allow delivery by several consecutive messages;
3. may have support for rich-html;
4. have a length limit for a single message;
5. allow external code to detect reject and retry.

This means that for a supported transport profile in v1 the module must always return a DeliveryPlan, because in the worst case the message can be represented as plain text and sliced into several chunks.

### Important consequence

Inside the module there is no fallback like summary + file.
summary, file, a repeated LLM call and other product scenarios are out of scope of this RFC.

---

## 4. Goals

The module must:

1. accept markdown-like rich text;
2. parse it into a normalized internal representation;
3. build a delivery plan under transport limits;
4. keep structure and formatting when possible;
5. degrade chunking and rendering strategy when needed;
6. return the result as an array of chunks;
7. support replanning only the undelivered tail after a transport reject;
8. be isolatable and testable;
9. not depend on a specific transport SDK;
10. not perform network requests.

---

## 5. Non-goals

Not included into the first version:

- sending messages;
- retry orchestration;
- work with webhook, polling, queues and other transport concerns;
- repeated call to LLM;
- summary, file fallback, send as document;
- support of all markdown dialects;
- support of Telegram entities;
- use of raw HTML as a canonical internal representation;
- search for a globally optimal packing of chunks.

---

## 6. Decisions

Below are decisions fixed for v1.

### 6.1. Transport-agnostic module
The module does not depend on Telegram SDK or any other transport.
It accepts a TransportProfile and returns prepared chunks.

### 6.2. Result of any attempt is always an array of chunks
Even if the message fits whole, the result has the form:

```ts
chunks: [singleChunk]
```

### 6.3. Chunk is a typed object
A chunk contains not only text but also metadata:

- rendering mode;
- length estimate;
- index;
- a logical range of the content inside the normalized IR that it refers to.

### 6.4. Rendering is part of the library
In the first version the library itself is responsible for:

```text
markdown -> normalized IR -> planning -> rendering -> typed chunks
```

That is, the transformations markdown -> rich-html and markdown -> plain-text are part of the module, not an external duty.

### 6.5. The last degradation stage inside the module is forced-plain-text
At the last stage:

- all formatting is dropped;
- the text remains plain text;
- slicing is done in the most reliable way on Unicode-safe boundaries.

### 6.6. Already delivered prefix is considered committed
If a reject happened on chunk i, then:

- chunks 0 .. i-1 are considered already delivered;
- they are not resent;
- only the tail is replanned starting from the failed chunk.

### 6.7. We do not cut by bytes
The module works with strings and Unicode-safe boundaries.
Cutting by bytes is forbidden.

### 6.8. In the first version a simple length estimate is used
For v1 we use:

```ts
countMethod: 'string-length'
```

with a conservative safeTextBudget.

Under string-length in v1 we normatively mean plain JS string.length, that is, length in UTF-16 code units.

### 6.9. planDelivery() escalates strategies itself
If a plan cannot be built on the requested strategy, the module does not return an error "does not fit", but sequentially moves to more aggressive strategies up to forced-plain-text.

requestedStrategy in the input is the minimal softness for start, and usedStrategy in the result is the first strategy on which a valid plan was built.

### 6.10. SourceRange refers to normalized IR
Source ranges in chunks refer not to the raw markdown string but to the normalized internal representation of the document.

This means that sourceRange describes a logical range inside the normalized IR and is used also for replanning the undelivered tail.

SourceRange must be stable within one version of parser + normalizer.

---

## 7. Terms

### Chunk
One part of a message, acceptable for sequential sending to the transport.

### Delivery plan (DeliveryPlan)
The result of the module: an array of chunks and diagnostic information.

### Strategy (SplitStrategy)
The strictness level of preparation and degradation of the message.

### Budget
The maximum allowed length of one chunk by the internal estimate.

### IR
Internal normalized representation of the document.

### Greedy packing
An algorithm that goes through blocks from left to right and adds them into the current chunk while the budget is not exceeded.

### Remaining tail
The part of the message starting from the first chunk that the transport did not accept.

---

## 8. General model

Instead of the pipeline:

```text
markdown -> html -> transport
```

we use the pipeline:

```text
markdown -> parser -> normalized IR -> planner -> renderer -> typed chunks -> transport adapter
```

Where:

- parser — parses the markdown;
- normalizer — brings the structure to a supported subset;
- planner — builds a chunk plan;
- renderer — renders a chunk into rich-html or plain-text;
- transport adapter — is outside the module and is responsible only for sending and retry orchestration.

---

## 9. Supported Markdown subset

In the first version we support:

- paragraphs;
- headings;
- lists;
- quotes;
- fenced code blocks;
- strong / emphasis;
- inline code;
- links;
- line breaks.

In the first version we simplify or drop:

- raw HTML;
- tables;
- footnotes;
- directives;
- non-standard markdown extensions;
- complex nests that we cannot express in the limited IR.

### Rule for unsupported constructs

1. if possible, normalize to the nearest supported type;
2. otherwise simplify to plain text;
3. record the degradation in diagnostics.

For v1 the following general policy is normative:

1. if an unsupported construct can be safely reduced to a supported structure — reduce it;
2. otherwise transform it into a plain-text representation keeping the text order;
3. attempts to partially keep exotic structure as arbitrary HTML subset are not required.

### Separate rule for raw HTML

Raw HTML from input markdown in v1 is not interpreted as markup and is not passed to output as HTML structure.

It is treated as literal text:

- in rich-html it is escaped;
- in plain-text it remains as text.

Minimal normative examples of unsupported markdown in v1:

- a table is normalized into a plain-text block, for example:

  ```text
  A | B
  1 | 2
  ```

- a footnote is kept as plain text in the linear order of the document without any special reference mechanics;
- a raw HTML block is kept as literal text:
  - in rich-html — escaped;
  - in plain-text — as is;
- exotic nested constructs are flattened into plain text keeping the text order.

---

## 10. Normalized internal representation (IR)

For the first version we need a limited IR with separation into block and inline elements.

### Block types

- paragraph
- heading
- list
- list_item
- quote
- code_block
- thematic_break

### Inline types

- text
- strong
- emphasis
- inline_code
- link
- soft_break
- hard_break

### List form

In v1 we accept the structure:

```text
list -> list_item -> blocks
```

This gives a correct basis for:

- complex list items;
- nested paragraphs;
- normal split policy.

### Requirement for IR

The IR must be sufficient so that the planner can:

- measure and pack the document;
- choose split points;
- render chunks;

without reanalyzing the original markdown string.

### IR determinism and source range addressing

For v1 the normalized IR must be strict and deterministic enough so that the same input markdown with the same version of parser + normalizer gives the same IR structure and the same addressing of SourceCursor.path.

SourceCursor.path is the path from the root of the normalized IR to the addressed leaf node.

For v1 the addressable leaf nodes are those that contain linear textual content:

- text
- inline_code
- code_block

It is also allowed to address a synthetic text-like leaf if the implementation uses it inside the normalizer.

offsetUtf16 allows to start and end a range inside a text-bearing leaf and is measured in UTF-16 code units, that is, by the semantics of plain JS string.length.

SourceRange in v1 is an opaque internal address: it is produced by the module and then used by the same module in replanTail(). The integration layer must not construct path manually.

---

## 11. Rendering modes

In v1 we support two modes:

```ts
type RenderMode = 'rich-html' | 'plain-text';
```

Also the caller can request:

```ts
type PreferredMode = 'auto' | 'rich-html' | 'plain-text';
```

Where:

- auto means:
  - use rich-html if the transport supports it;
  - otherwise plain-text.

Semantics of preferredMode for planDelivery():

- auto means to start with rich-html if the transport supports it, otherwise with plain-text;
- rich-html means to try to build a plan in rich mode with allowed further degradation to plain-text if needed for success;
- plain-text means to plan the message immediately in plain text without trying to start with rich-html.

### 11.1. rich-html

The renderer must generate only a transport-safe HTML subset.

For the first version the following are allowed:

- <b> / <strong>
- <i> / <em>
- <code>
- <pre>
- <a>

Requirements:

- raw HTML from input is not passed as is;
- unsafe content is escaped;
- arbitrary tags and attributes are not generated.

Additional rules for rendering block types in v1:

- heading is rendered as <b>Heading text</b> with normal separation of blocks by line breaks;
- levels h1..h6 as separate HTML semantics are not kept in v1;
- quote is not rendered by <blockquote>, but as quoted lines with the prefix &gt; ;
- thematic_break is rendered as a separate line --- with normal empty lines around by block rules.

Additional rules for rendering links in v1:

- if the link label differs from the URL, the link is rendered as <a href="URL">label</a>;
- if the label matches the URL or is absent, the link is rendered as <a href="URL">URL</a>.

### 11.2. plain-text

The renderer removes formatting, but keeps:

- line breaks;
- empty lines between paragraphs;
- a readable representation of lists;
- a readable representation of a code block.

Additional rules v1:

- if the link label differs from the URL, the link is rendered as label (URL);
- if the label matches the URL or is absent, just URL is rendered;
- thematic_break is rendered as a separate line ---;
- raw HTML stays literal text and is not interpreted as markup.

### 11.3. Canonical block spacing for v1

If not stated otherwise, top-level blocks are separated by exactly one empty line:

```text
\n\n
```

Canonical rules of block spacing for golden tests:

- paragraph: renders as the paragraph text; between neighboring paragraphs — \n\n;
- heading:
  - rich-html: <b>...</b>;
  - plain-text: normal heading text;
  - after heading we use normal block separation \n\n;
- list:
  - neighboring list_item are separated by one \n;
  - between a list and a neighboring top-level block we use \n\n;
- list_item:
  - first line: list marker (- or 1. etc.) + content of the first paragraph;
  - if the item has several blocks inside, additional blocks are rendered from a new line with two-space indent;
  - a continuation paragraph inside the same list_item is separated by \n;
- quote:
  - in plain-text every line has the prefix > ;
  - in rich-html every line has the prefix &gt; ;
  - if a quote contains several paragraphs, we insert one empty quoted line between them, that is, a separate line with only one quoted prefix:

    ```text
    > first paragraph
    >
    > second paragraph
    ```

- thematic_break is always rendered as a separate block with the line --- and normal separation \n\n.

### 11.4. Canonical plain-text representation of a code block for v1

In plain-text every code_block is rendered as a fenced block with triple backticks.

Without a language info string:

````text
```
code line 1
code line 2
```
````

If the implementation stores the language info string in IR, it is allowed to keep it in the opening fence, but this is not required for v1:

````text
```ts
code line 1
code line 2
```
````

If a code_block in plain-text or forced-plain-text is split into several chunks, each chunk gets its own balanced fenced block.

---

## 12. Preparation and degradation strategies v1

In the first version we fix the following set of strategies:

```ts
type SplitStrategy =
  | 'preserve'
  | 'split-blocks'
  | 'split-blocks-soft'
  | 'plain-text'
  | 'forced-plain-text';
```

This is a minimal and sufficient set for the basic logic.

### 12.1. preserve

- no slicing is done;
- the document is rendered as a whole;
- if the result does not fit the budget, we need the next strategy.

### 12.2. split-blocks

- only splitting by top-level blocks is allowed;
- every block is considered atomic;
- if a block does not fit even into an empty chunk, we need the next strategy.

### 12.3. split-blocks-soft

- additionally it is allowed to split long:
  - paragraph
  - list_item
  - quote
- code_block in v1 stays atomic;
- if an oversized block cannot be safely split in rich mode, the next strategy is plain-text.

### 12.4. plain-text

- the whole document is rendered as plain text;
- basic readability is kept;
- split is done by “soft” text boundaries.

### 12.5. forced-plain-text

- all formatting is fully dropped;
- the most reliable split strategy is used;
- order of boundaries:
  1. \n\n
  2. \n
  3. whitespace
  4. forced split by Unicode-safe string boundary

For the same input, transport profile, preferred mode and requested strategy the split result within one implementation version must be deterministic.

If there are several allowed split points:

1. choose the boundary of the highest priority;
2. among boundaries of the same type choose the rightmost one that does not exceed the budget.

This is the last stage inside the module.

---

## 13. Algorithm planDelivery

### 13.1. High-level algorithm

```text
1. Parse markdown
2. Normalize to supported IR
3. Choose initial render mode
4. Compute effective budget
5. Try to build a plan on the requested strategy
6. If the current strategy gives an invalid plan — escalate the strategy
7. Perform greedy sequential packing of blocks into chunks
8. Render every chunk
9. Validate the length of every chunk by the final rendered content
10. Return DeliveryPlan
```

planDelivery() in v1 must escalate strategies itself, starting from the requested one, until we get a valid DeliveryPlan.

If the input markdown is empty or after normalize it has no deliverable content, the module returns an empty plan:

```ts
chunks: []
```

Empty input must not turn into one empty chunk.

The normative escalation ladder in v1:

```text
preserve
-> split-blocks
-> split-blocks-soft
-> plain-text
-> forced-plain-text
```

Stages are not skipped by default. usedStrategy is the first strategy on which we managed to build a valid plan.

### 13.2. Packing rule

We use greedy packing:

- the planner goes through top-level blocks left to right;
- adds a block to the current chunk while the budget is not exceeded;
- if the next block does not fit and the current chunk is not empty — the block moves to the next chunk;
- if a block does not fit even into an empty chunk — we apply the split policy for this block type.

### 13.3. Important semantics of split

If a chunk needs to be split, the planner:

- searches for the longest prefix that does not exceed the budget;
- prefers softer boundaries;
- does not split text “in half for symmetry”;
- does not make 1800 + 1800 if we can make 3490 + 110.

In other words: the split is not “about the middle”, but by the rule of the maximal allowed prefix.

When checking the budget the normative length is the length of the final content after render and escape:

- for rich-html — length of the final HTML string;
- for plain-text — length of the final plain-text string.

Intermediate estimates are allowed only as an internal optimization of the planner.

### 13.4. Determinism

For the same input markdown, the same normalized IR, transport profile, preferredMode, requestedStrategy and within one implementation version the planning result must be deterministic.

If there are several allowed split points of the same priority, we choose the rightmost point that does not exceed the budget.

---

## 14. Split rules by block types

### 14.1. Paragraph

In preserve and split-blocks a paragraph is considered atomic.

In split-blocks-soft a paragraph can be split.

Order of preferred boundaries:

1. end of sentence;
2. ;
3. ,
4. whitespace
5. forced split by Unicode-safe boundary

Note: “end of sentence” in v1 may be detected heuristically by characters ., !, ?.

For v1 a simple punctuation-based heuristic at regex level is allowed, without NLP and without complex language analysis. The implementation is not required to try to detect abbreviations, numbers, domains, URLs and other special cases.

If there are several allowed boundaries of the same priority, we choose the rightmost boundary that does not exceed the budget.

### 14.2. List / List item

- priority is to keep the integrity of list_item;
- if a list_item is too long, it is allowed to split its inner paragraph blocks;
- if the original form cannot be kept without breaking the budget, the continuation may be rendered as a normal paragraph.

When splitting a long list_item the planner should keep the list marker (-, *, 1. etc.) in every continuation fragment when possible. Losing the marker is allowed only as a more degraded fallback.

Repeating the marker in a continuation fragment applies equally for rich-html and plain-text. Priorities for v1 are:

1. keep the list_item whole;
2. if a split is needed — keep the marker in the continuation fragment;
3. if this is already impossible without breaking the budget or breaking the structure — degrade the continuation to a paragraph.

### 14.3. Heading

- if possible a heading is not split;
- if in rich mode it is too long, on a later strategy it will be processed as plain text.

### 14.4. Quote

- splitting is done by inner blocks;
- if inside there is a single too long paragraph, we apply the paragraph split rule.

### 14.5. Code block

In v1 a code block is considered atomic in rich mode.

If a code block is oversized:

- in preserve and split-blocks it causes moving to a more aggressive strategy;
- in split-blocks-soft it is still atomic;
- in plain-text and forced-plain-text code is already treated as text with line breaks and is cut by the common plain text split rules.

At the same time the canonical plain-text output for code_block stays fenced: if the code is split into several chunks, each chunk must contain its own balanced fenced block, not an unfinished half of a fence.

Similarly, a giant inline code and a giant rich link in rich mode are considered atomic inline constructs. If they do not allow us to build a valid rich chunk, the strategy must escalate further. In plain-text and forced-plain-text such fragments can be cut as normal text.

### 14.6. Unsupported block

- the block is normalized into a plain text representation;
- the fact of degradation is fixed in diagnostics.

For v1 this is the normative policy also for unsupported markdown in general: such constructs are lowered to a plain-text representation without attempts to keep them as an arbitrary HTML structure.

---

## 15. Unicode-safe split

The module must not cut by bytes and must not operate on Buffer as the base text model.

In v1 the following rules apply:

1. split is done by string boundaries, not by bytes;
2. a forced split must not break a surrogate pair;
3. if possible we should avoid a split inside complex Unicode sequences;
4. for safety we use a conservative safeTextBudget.

### Important

The term “UTF-8 boundaries” is not used in this RFC, because we do not talk about a byte encoding, but about safe work with strings. The correct term for this specification is Unicode-safe boundaries.

At the same time in v1 the budget is still counted in UTF-16 code units, that is by the normal JS string.length. The requirement of Unicode-safe split refers to the safety of the split point, not to the unit of the budget.

---

## 16. Transport profile and budget policy

The module does not know about Telegram directly, but accepts a transport profile.

### Minimal profile v1

```ts
interface TransportProfile {
  maxTextLength: number;
  safeTextBudget: number;
  supportsPlainText: true;
  supportsMultipartPlainText: true;
  supportsRichHtml: boolean;
  countMethod: 'string-length';
}
```

### Rules

- safeTextBudget <= maxTextLength
- the planner uses safeTextBudget, not the formal transport limit
- budget policy can be reduced by external code after a reject
- validity of a chunk is checked by the length of the final rendered content
- in v1 countMethod: 'string-length' means normal JS string.length

### Practical recommendation for a Telegram-like transport

For the first integration it is acceptable to start with a budget of about 3600 characters and lower it outside on transport rejects.

---

## 17. Public contract of the module

### 17.1. Types

```ts
type PreferredMode = 'auto' | 'rich-html' | 'plain-text';

type RenderMode = 'rich-html' | 'plain-text';

type SplitStrategy =
  | 'preserve'
  | 'split-blocks'
  | 'split-blocks-soft'
  | 'plain-text'
  | 'forced-plain-text';

interface TransportProfile {
  maxTextLength: number;
  safeTextBudget: number;
  supportsPlainText: true;
  supportsMultipartPlainText: true;
  supportsRichHtml: boolean;
  countMethod: 'string-length';
}

interface SourceCursor {
  path: number[];
  offsetUtf16: number;
}

interface SourceRange {
  start: SourceCursor;
  end: SourceCursor;
}

interface PlanRequest {
  markdown: string;
  preferredMode: PreferredMode;
  strategy: SplitStrategy;
  transport: TransportProfile;
}
```

SourceRange in v1 refers to the normalized IR, not to the original markdown string. The range is understood as a half-open interval [start, end).

Additional normative semantics:

- path is the path from the root of the normalized IR to the addressed leaf node;
- offsetUtf16 is measured in UTF-16 code units;
- start and end can point inside a text-bearing leaf;
- the same input within one version of parser + normalizer must give the same addressing of path;
- SourceRange is an internal opaque address and is not intended to be built by external code.

### 17.2. Chunk

```ts
interface PlannedChunk {
  index: number;
  total: number;
  mode: RenderMode;
  content: string;
  estimatedLength: number;
  sourceRange: SourceRange;
}
```

For v1 it is allowed and recommended to set:

```ts
estimatedLength = content.length
```

That is, despite the historical name of the field, in v1 it can semantically be the actually measured length of the final rendered content.

### 17.3. Diagnostics

```ts
interface PlanDiagnostics {
  sourceLength: number;
  plainTextLengthEstimate: number;
  normalizedBlockCount: number;
  chunkCount: number;
  requestedStrategy: SplitStrategy;
  usedStrategy: SplitStrategy;
  requestedMode: PreferredMode;
  usedMode: RenderMode;
  hadDegradation: boolean;
  degradedToPlainText: boolean;
  splitBlockTypes: string[];
}
```

Semantics of splitBlockTypes in v1:

- this is a unique list of block types that we really had to split;
- the order of elements — by the first appearance;
- repeated split of the same type is not duplicated.

Values of splitBlockTypes must match the types of block nodes of the normalized IR.

### 17.4. Result

```ts
interface DeliveryPlan {
  chunks: PlannedChunk[];
  diagnostics: PlanDiagnostics;
}
```

### 17.5. Errors

In a supported transport profile the module must return a DeliveryPlan.

An error is allowed only in cases:

- invalid TransportProfile;
- internal programming error;
- violation of implementation invariants.

Errors are not a normal way to express “does not fit”.

---

## 18. Replanning after reject

Retry orchestration stays outside the module, but the module must support replanning of the undelivered tail.

### 18.1. Normative rule

If the transport rejected the chunk with index i, then:

- chunks 0 .. i-1 are considered delivered successfully;
- they are not resent;
- the logical tail of the document is replanned starting from previousPlan.chunks[i].sourceRange.start and until the end of the normalized IR.

### 18.2. Reasons of reject

Minimal supported reasons:

```ts
type RejectReason =
  | 'too-long'
  | 'invalid-markup'
  | 'transport-reject';
```

### 18.3. Replanning contract

```ts
interface ReplanTailRequest {
  markdown: string;
  previousPlan: DeliveryPlan;
  failedChunkIndex: number;
  preferredMode: PreferredMode;
  nextStrategy: SplitStrategy;
  transport: TransportProfile;
  rejectReason: RejectReason;
}
```

```ts
interface ReplannedTail {
  chunks: PlannedChunk[];
  diagnostics: PlanDiagnostics;
}
```

replanTail() in v1 parses and normalizes the input markdown again, then selects the logical tail from the newly built normalized IR by previousPlan.chunks[failedChunkIndex].sourceRange.start.

replanTail() accepts its own preferredMode. The tail is replanned not in the implicitly inherited mode of the previous plan, but with the explicitly given mode preference, a new nextStrategy and the current transport.

The tail is restored not from a substring of markdown, but from the normalized IR. Caching IR between attempts is allowed as an optimization, but is not required by the contract.

replanTail() in v1 must escalate strategies itself the same way as planDelivery(): starting from the passed nextStrategy, it sequentially goes by the same normative ladder up to forced-plain-text until a valid tail plan is built.

### 18.4. Semantics

- for too-long the caller usually:
  - passes the same preferredMode as used before,
  - lowers the budget,
  - if needed, raises the aggressiveness of the strategy;
- for invalid-markup the caller usually:
  - passes preferredMode: 'plain-text',
  - if needed, raises the strategy.

Semantics of preferredMode for replanTail() matches planDelivery():

- auto means to start with rich-html if the transport supports it, otherwise with plain-text;
- rich-html means to try to build the tail in rich mode with allowed further degradation to plain-text if needed for success;
- plain-text means to plan the tail in plain text right away without a new attempt to start with rich-html.

For v1 the recommended reaction to invalid-markup is normatively simplified to switching rich-html -> plain-text for the undelivered tail. Attempts to “heal” the markup by more aggressive rich split are not required in v1.

### 18.5. Important consequence

The final delivery of the message may become mixed by formats:

- early chunks went as rich-html;
- the tail after reject was rebuilt as plain-text.

This is acceptable. Priorities are:

1. do not duplicate what was already delivered;
2. deliver the tail;
3. keep formatting as much as possible.

Chunk indices are local to each plan:

- the original DeliveryPlan has indices 0..N-1;
- the result of replanTail() has its own indices 0..M-1.

usedMode in diagnostics reflects the mode actually used by the tail plan and may differ from the requested preferredMode if during replanning we had to degrade to plain-text.

---

## 19. Invariants

The module must keep the following invariants:

1. planDelivery() and replanTail() do not perform network requests;
2. the module does not depend on a specific transport SDK;
3. the result of any successful attempt is an array of chunks;
4. every chunk has mode, content, estimatedLength, sourceRange;
5. no chunk must exceed safeTextBudget by countMethod applied to the final rendered content;
6. for a supported transport profile the module must always be able to return to forced-plain-text and produce a plan;
7. the already delivered prefix is not resent when replanning the tail;
8. raw HTML is not cut and is not passed as a canonical structure;
9. the module does not cut by bytes;
10. a forced split is allowed only by a Unicode-safe string boundary;
11. degradation of formatting must not lead to loss of essential text, except the allowed normalization of markup.

---

## 20. Diagnostics and observability

The module must return diagnostics suitable for:

- debugging problematic inputs;
- analysis of rejects from the transport;
- tuning of budget policy;
- evolution of split rules.

### Minimal set of diagnostics

- length of the source markdown;
- estimate of plain-text length;
- number of blocks after normalize;
- number of chunks;
- requested strategy;
- actually used strategy;
- requested mode;
- actually used mode;
- fact of degradation;
- fact of switch to plain text;
- block types that we had to split.

Diagnostics must not be a mandatory part of the transport business logic, but must be available for logging and tests.

If an unsupported block / markdown was lowered to a plain-text representation, or a continuation fragment of list_item had to be simplified to a paragraph, this must be reflected at least by hadDegradation = true and by the proper entries in splitBlockTypes where applicable.

Do not include into splitBlockTypes the constructs that were just degraded without an actual split. For example, unsupported markdown and raw HTML must not get there only because they were lowered or escaped.

---

## 21. Test strategy

### 21.1. Unit tests

We need separate coverage for:

- parsing / normalization;
- rich-html renderer;
- plain-text renderer;
- split paragraph;
- split list item;
- replanning tail;
- strategy escalation.

### 21.2. Golden tests

We check:

- number of chunks;
- mode of every chunk;
- strategy used;
- content of every chunk;
- sourceRange;
- final concatenation of the plain-text representation.

### 21.3. Property-like tests

We check invariants:

- every chunk does not exceed the budget;
- for a supported profile planDelivery() always returns a result;
- forced-plain-text always returns a plan for any non-empty text;
- when replanning the tail the already delivered prefix does not change;
- concatenation of plain-text chunks does not lose significant text beyond the allowed degradation.

### 21.4. Mandatory nasty cases

1. giant paragraph;
2. giant code block;
3. one super long line without spaces;
4. giant URL;
5. giant inline code;
6. broken markdown;
7. raw HTML inside markdown;
8. emoji, ZWJ and combining characters;
9. nested lists;
10. combinations of quote + code + link;
11. reject in the middle of an already sent sequence of chunks.

For golden tests and unit tests the behavior must be deterministic within one implementation version: for the same input data and transport profile we expect the same DeliveryPlan.

---

## 22. Responsibility boundary

### 22.1. Inside the module

The module is responsible for:

- parse;
- normalize;
- planning;
- rendering;
- diagnostics;
- replanning of the undelivered tail.

### 22.2. Outside the module

The external integration layer is responsible for:

- actual sending;
- sequential sending of chunks;
- handling rejects;
- choosing the next strategy;
- reducing the budget;
- retry orchestration;
- logging and product metrics.

---

## 23. Non-recommended interpretations

To avoid ambiguity in v1 we should not understand the RFC as if:

- the result can be “sometimes a string, sometimes an array”;
- summary is a part of fallback inside the module;
- file is needed for the basic guarantee logic;
- the library can return “nothing” if plain text is too long;
- split by bytes is an allowed last resort;
- a repeated attempt after reject should resend the already sent prefix.

All these interpretations are considered incorrect for this version of the RFC.

---

## 24. Implementation recommendations

The choice of a concrete markdown stack is not a normative part of the specification.

Allowed options:

- unified / remark
- markdown-it
- another parser if it allows to build the required IR

What is normative is not the library, but the contract:

```text
markdown -> normalized IR -> planner -> renderer
```

---

## 25. Scope of the first version

In the first version we must implement:

- parse markdown;
- normalize into a limited IR;
- rich-html renderer;
- plain-text renderer;
- strategies:
  - preserve
  - split-blocks
  - split-blocks-soft
  - plain-text
  - forced-plain-text
- planDelivery();
- helper to move to the next, more aggressive strategy;
- replanTail();
- diagnostics basic;
- unit tests and golden tests for basic scenarios.

---

## 26. Possible extensions after v1

The following features are not in the current scope, but may appear later:

- split-code-lines;
- simplify-formatting;
- more precise Unicode-aware split up to grapheme cluster level;
- alternative count methods;
- renderer to Telegram entities;
- extended markdown subset.

---

## 27. System guarantees within this RFC

For a supported transport profile the system guarantees:

1. the module always returns a delivery plan as one or more chunks;
2. in a normal case the plan has one chunk;
3. if the goal is not reached in rich mode, the module degrades to plain text;
4. if a reject happened in the middle, only the undelivered tail is replanned;
5. the already delivered part is not duplicated by the module.

The system does not guarantee:

- exact keeping of all formatting;
- identical rendering to the source markdown;
- no degradation in pathological cases;
- a globally optimal number of chunks.

---

## 28. Short summary of the solution

The base logic v1 is formulated like this:

1. Get markdown.
2. Convert it to a normalized IR.
3. Try to send as one rich chunk.
4. If it does not fit — split into chunks by document structure.
5. If rich mode does not pass — switch to plain text.
6. In the last resort use forced-plain-text.
7. Always return an array of typed chunks.
8. On a reject in the middle replan only the undelivered tail.
