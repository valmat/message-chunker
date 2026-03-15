import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDelivery } from '../src/planner.js';
import { replanTail } from '../src/replan.js';

// Default transport profile for tests
const transport = {
    maxTextLength: 4096,
    safeTextBudget: 3600,
    supportsPlainText: true,
    supportsMultipartPlainText: true,
    supportsRichHtml: true,
    countMethod: 'string-length',
};

function plan(markdown, opts = {}) {
    return planDelivery({
        markdown,
        preferredMode: opts.preferredMode || 'auto',
        strategy: opts.strategy || 'preserve',
        transport: { ...transport, ...opts.transport },
    });
}

function replan(markdown, previousPlan, failedIndex, opts = {}) {
    return replanTail({
        markdown,
        previousPlan,
        failedChunkIndex: failedIndex,
        preferredMode: opts.preferredMode || 'auto',
        nextStrategy: opts.nextStrategy || 'preserve',
        transport: { ...transport, ...opts.transport },
        rejectReason: opts.rejectReason || 'too-long',
    });
}

// =============== basic replan ===============

describe('replanTail — basic', () => {
    it('replans tail from failed chunk index', () => {
        const p = 'Paragraph content here. '.repeat(6); // ~144 chars
        const md = p + '\n\n' + p + '\n\n' + p;
        const original = plan(md, { transport: { safeTextBudget: 250 } });

        // Simulate: chunk 1 failed
        assert.ok(original.chunks.length >= 2);
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: 250 },
        });

        assert.ok(tail.chunks.length >= 1);
        const tailText = tail.chunks.map(c => c.content).join(' ');
        assert.ok(tailText.length > 0);
    });

    it('replans from the first chunk (all failed)', () => {
        const md = 'Hello world';
        const original = plan(md);

        const tail = replan(md, original, 0);
        assert.equal(tail.chunks.length, 1);
        assert.ok(tail.chunks[0].content.includes('Hello'));
    });

    it('replans from the last chunk', () => {
        const md = 'A'.repeat(150) + '\n\n' + 'B'.repeat(150) + '\n\n' + 'C'.repeat(150);
        const original = plan(md, { transport: { safeTextBudget: 200 } });
        const lastIdx = original.chunks.length - 1;

        const tail = replan(md, original, lastIdx, {
            transport: { safeTextBudget: 200 },
        });
        assert.ok(tail.chunks.length >= 1);
    });
});

// =============== tail chunk indices ===============

describe('replanTail — chunk indices', () => {
    it('tail chunks have fresh indices starting from 0', () => {
        const p = 'Sentence here. '.repeat(10); // ~150 chars
        const md = p + '\n\n' + p + '\n\n' + p;
        const original = plan(md, { transport: { safeTextBudget: 250 } });

        assert.ok(original.chunks.length >= 2);
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: 250 },
        });

        for (let i = 0; i < tail.chunks.length; i++) {
            assert.equal(tail.chunks[i].index, i);
            assert.equal(tail.chunks[i].total, tail.chunks.length);
        }
    });
});

// =============== strategy escalation ===============

describe('replanTail — strategy escalation', () => {
    it('escalates strategy when needed', () => {
        const md = 'Short\n\n' + 'x'.repeat(500);
        const original = plan(md, { transport: { safeTextBudget: 250 } });

        // Replan from chunk 0 with preserve — should escalate
        const tail = replan(md, original, 0, {
            nextStrategy: 'preserve',
            transport: { safeTextBudget: 250 },
        });

        assert.ok(tail.chunks.length >= 1);
        for (const chunk of tail.chunks) {
            assert.ok(chunk.content.length <= 250);
        }
    });

    it('respects the given nextStrategy as starting point', () => {
        const p = 'Sentence here. '.repeat(10); // ~150 chars
        const md = p + '\n\n' + p + '\n\n' + p;
        const original = plan(md, { transport: { safeTextBudget: 250 } });

        const tail = replan(md, original, 1, {
            nextStrategy: 'split-blocks',
            transport: { safeTextBudget: 250 },
        });

        assert.equal(
            tail.diagnostics.requestedStrategy, 'split-blocks',
            `expected requestedStrategy split-blocks, got ${tail.diagnostics.requestedStrategy}`
        );
    });

    it('can escalate to forced-plain-text for very tough content', () => {
        const md = 'x'.repeat(800);
        const original = plan(md, { transport: { safeTextBudget: 200 } });

        const tail = replan(md, original, 0, {
            nextStrategy: 'preserve',
            transport: { safeTextBudget: 200 },
        });

        assert.ok(tail.chunks.length >= 2);
        for (const chunk of tail.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });
});

// =============== sourceRange correctness ===============

describe('replanTail — sourceRange', () => {
    it('sourceRange paths reference the full IR, not the tail subset', () => {
        const p = 'Sentence here. '.repeat(10); // ~150 chars
        const md = p + '\n\n' + p + '\n\n' + p;
        const original = plan(md, { transport: { safeTextBudget: 250 } });

        // Find the chunk that starts at block index > 0
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: 250 },
        });

        // The first tail chunk should reference a block index >= 1
        const firstPath = tail.chunks[0].sourceRange.start.path[0];
        assert.ok(firstPath >= 1,
            `expected sourceRange path[0] >= 1, got ${firstPath}`);
    });
});

// =============== mode handling ===============

describe('replanTail — mode', () => {
    it('respects preferredMode plain-text', () => {
        const md = '**bold** text here. '.repeat(15) + '\n\n' + 'More text here. '.repeat(15);
        const original = plan(md, { transport: { safeTextBudget: 200 } });

        const tail = replan(md, original, 0, {
            preferredMode: 'plain-text',
            transport: { safeTextBudget: 200 },
        });

        for (const chunk of tail.chunks) {
            assert.equal(chunk.mode, 'plain-text');
        }
    });

    it('auto mode uses rich-html when transport supports it', () => {
        const md = 'Hello world';
        const original = plan(md);

        const tail = replan(md, original, 0, { preferredMode: 'auto' });
        assert.equal(tail.chunks[0].mode, 'rich-html');
    });

    it('falls back to plain-text when transport lacks rich-html', () => {
        const md = 'Hello world';
        const original = plan(md, { transport: { supportsRichHtml: false } });

        const tail = replan(md, original, 0, {
            transport: { supportsRichHtml: false },
        });
        assert.equal(tail.chunks[0].mode, 'plain-text');
    });
});

// =============== diagnostics ===============

describe('replanTail — diagnostics', () => {
    it('reports correct diagnostics', () => {
        const p = 'Sentence here. '.repeat(10); // ~150 chars
        const md = p + '\n\n' + p + '\n\n' + p;
        const original = plan(md, { transport: { safeTextBudget: 250 } });

        const tail = replan(md, original, 1, {
            nextStrategy: 'split-blocks',
            transport: { safeTextBudget: 250 },
        });

        assert.equal(tail.diagnostics.requestedStrategy, 'split-blocks');
        assert.equal(tail.diagnostics.requestedMode, 'auto');
        assert.equal(tail.diagnostics.chunkCount, tail.chunks.length);
        assert.ok(tail.diagnostics.normalizedBlockCount >= 1);
    });

    it('reports degradation when strategy escalated', () => {
        const md = 'x'.repeat(500);
        const original = plan(md, { transport: { safeTextBudget: 200 } });

        const tail = replan(md, original, 0, {
            nextStrategy: 'preserve',
            transport: { safeTextBudget: 200 },
        });

        assert.ok(tail.diagnostics.hadDegradation);
    });
});

// =============== budget invariant ===============

describe('replanTail — budget invariant', () => {
    it('no tail chunk exceeds safeTextBudget', () => {
        const cases = [
            'Word. '.repeat(100),
            '# Title\n\nParagraph. '.repeat(30) + '\n\n```\ncode\n```',
            'x'.repeat(1000),
        ];
        for (const md of cases) {
            const original = plan(md, { transport: { safeTextBudget: 200 } });
            if (original.chunks.length < 2) continue;

            const tail = replan(md, original, 1, {
                transport: { safeTextBudget: 200 },
            });

            for (const chunk of tail.chunks) {
                assert.ok(
                    chunk.content.length <= 200,
                    `Budget exceeded in tail: ${chunk.content.length} > 200`
                );
            }
        }
    });
});

// =============== validation ===============

describe('replanTail — validation', () => {
    it('throws on invalid failedChunkIndex', () => {
        const md = 'Hello world';
        const original = plan(md);

        assert.throws(() => replan(md, original, -1), RangeError);
        assert.throws(() => replan(md, original, 5), RangeError);
    });

    it('throws on unknown strategy', () => {
        const md = 'Hello world';
        const original = plan(md);

        assert.throws(
            () => replanTail({
                markdown: md,
                previousPlan: original,
                failedChunkIndex: 0,
                preferredMode: 'auto',
                nextStrategy: 'unknown-strategy',
                transport,
                rejectReason: 'too-long',
            }),
            /Unknown strategy/
        );
    });

    it('throws on unknown rejectReason', () => {
        const md = 'Hello world';
        const original = plan(md);

        assert.throws(
            () => replanTail({
                markdown: md,
                previousPlan: original,
                failedChunkIndex: 0,
                preferredMode: 'auto',
                nextStrategy: 'preserve',
                transport,
                rejectReason: 'invalid-reason',
            }),
            /Unknown rejectReason/
        );
    });

    it('throws on deprecated format-rejected reason', () => {
        const md = 'Hello world';
        const original = plan(md);

        assert.throws(
            () => replanTail({
                markdown: md,
                previousPlan: original,
                failedChunkIndex: 0,
                preferredMode: 'auto',
                nextStrategy: 'preserve',
                transport,
                rejectReason: 'format-rejected',
            }),
            /Unknown rejectReason/
        );
    });

    it('throws on deprecated transport-reject reason', () => {
        const md = 'Hello world';
        const original = plan(md);

        assert.throws(
            () => replanTail({
                markdown: md,
                previousPlan: original,
                failedChunkIndex: 0,
                preferredMode: 'auto',
                nextStrategy: 'preserve',
                transport,
                rejectReason: 'transport-reject',
            }),
            /Unknown rejectReason/
        );
    });

    it('accepts valid rejectReason values per RFC', () => {
        const md = 'Hello world';
        const original = plan(md);

        for (const reason of ['too-long', 'invalid-markup']) {
            assert.doesNotThrow(() => replanTail({
                markdown: md,
                previousPlan: original,
                failedChunkIndex: 0,
                preferredMode: 'auto',
                nextStrategy: 'preserve',
                transport,
                rejectReason: reason,
            }));
        }
    });
});

// =============== delivered prefix not resent (inter-block) ===============

describe('replanTail — delivered prefix not resent (inter-block)', () => {
    it('tail does not contain content from delivered chunks', () => {
        const md = 'AAAA'.repeat(40) + '\n\n' + 'BBBB'.repeat(40) + '\n\n' + 'CCCC'.repeat(40);
        const original = plan(md, { transport: { safeTextBudget: 200 } });

        // Ensure at least 2 chunks
        assert.ok(original.chunks.length >= 2, `expected >= 2 chunks, got ${original.chunks.length}`);

        // Fail at chunk 1 — chunk 0 is delivered
        const deliveredContent = original.chunks[0].content;
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: 200 },
        });

        const tailFull = tail.chunks.map(c => c.content).join('\n');
        if (deliveredContent.includes('AAAA')) {
            assert.ok(!tailFull.startsWith('AAAA'),
                'tail should not start with delivered content');
        }
    });
});

// =============== intra-block reject: no prefix duplication ===============

describe('replanTail — intra-block reject: paragraph', () => {
    it('reject in 2nd chunk of split paragraph does not re-send delivered prefix', () => {
        // Single long paragraph with unique words to avoid false positive on includes()
        const words = Array.from({ length: 200 }, (_, i) => `w${i}`);
        const md = words.join(' '); // ~1000+ chars of unique text
        const budget = 250;
        const original = plan(md, {
            transport: { safeTextBudget: budget },
        });

        // Must have at least 3 chunks (single paragraph split)
        assert.ok(original.chunks.length >= 3,
            `expected >= 3 chunks for split paragraph, got ${original.chunks.length}`);

        // chunk 0 is delivered, chunk 1 is rejected
        const delivered = original.chunks[0].content;
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: budget },
        });

        assert.ok(tail.chunks.length >= 1, 'tail should have at least 1 chunk');

        // The tail must not contain the delivered prefix
        const tailFull = tail.chunks.map(c => c.content).join('');
        assert.ok(!tailFull.includes(delivered),
            'tail should not contain the already-delivered first chunk content');

        // Budget invariant
        for (const chunk of tail.chunks) {
            assert.ok(chunk.content.length <= budget,
                `tail chunk exceeds budget: ${chunk.content.length} > ${budget}`);
        }
    });

    it('intra-block sourceRange.start differs between split fragments', () => {
        const md = 'Sentence here. '.repeat(80); // ~1200 chars
        const budget = 250;
        const original = plan(md, {
            transport: { safeTextBudget: budget },
        });

        assert.ok(original.chunks.length >= 3,
            `expected >= 3 chunks, got ${original.chunks.length}`);

        // All chunks come from block 0 (single paragraph), but should have different cursors
        const starts = original.chunks.map(c => c.sourceRange.start);
        for (let i = 1; i < starts.length; i++) {
            const prev = starts[i - 1];
            const curr = starts[i];
            // Either path differs or offset differs
            const same = pathAndOffsetEqual(prev, curr);
            assert.ok(!same,
                `chunk ${i - 1} and ${i} have identical sourceRange.start: ` +
                `path=${JSON.stringify(curr.path)} offset=${curr.offsetUtf16}`);
        }
    });
});

describe('replanTail — intra-block reject: list item', () => {
    it('reject in 2nd chunk of split list item does not re-send delivered prefix', () => {
        // Single list item with very long text
        const longItem = '- ' + 'ListWord. '.repeat(120); // ~1200 chars in one item
        const md = longItem + '\n- Short item';
        const budget = 250;
        const original = plan(md, {
            transport: { safeTextBudget: budget },
        });

        // Find chunks from the long first list item
        assert.ok(original.chunks.length >= 3,
            `expected >= 3 chunks, got ${original.chunks.length}`);

        const delivered = original.chunks[0].content;
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: budget },
        });

        assert.ok(tail.chunks.length >= 1);

        const tailFull = tail.chunks.map(c => c.content).join('');
        assert.ok(!tailFull.includes(delivered),
            'tail should not contain the already-delivered list item prefix');

        for (const chunk of tail.chunks) {
            assert.ok(chunk.content.length <= budget,
                `tail chunk exceeds budget: ${chunk.content.length} > ${budget}`);
        }
    });
});

describe('replanTail — intra-block reject: quote', () => {
    it('reject in 2nd chunk of split quote does not re-send delivered prefix', () => {
        // Long quote that must be split
        const md = '> ' + 'QuoteWord. '.repeat(120); // ~1320 chars in one quote
        const budget = 250;
        const original = plan(md, {
            transport: { safeTextBudget: budget },
        });

        assert.ok(original.chunks.length >= 3,
            `expected >= 3 chunks, got ${original.chunks.length}`);

        const delivered = original.chunks[0].content;
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: budget },
        });

        assert.ok(tail.chunks.length >= 1);

        const tailFull = tail.chunks.map(c => c.content).join('');
        assert.ok(!tailFull.includes(delivered),
            'tail should not contain the already-delivered quote prefix');

        for (const chunk of tail.chunks) {
            assert.ok(chunk.content.length <= budget,
                `tail chunk exceeds budget: ${chunk.content.length} > ${budget}`);
        }
    });
});

describe('replanTail — intra-block reject: code block', () => {
    it('reject in 2nd chunk of split code block does not re-send delivered prefix', () => {
        // Long code block
        const codeLines = Array.from({ length: 60 }, (_, i) => `const x${i} = ${i};`).join('\n');
        const md = '```js\n' + codeLines + '\n```';
        const budget = 250;
        const original = plan(md, {
            transport: { safeTextBudget: budget },
        });

        assert.ok(original.chunks.length >= 3,
            `expected >= 3 chunks for split code block, got ${original.chunks.length}`);

        const delivered = original.chunks[0].content;
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: budget },
        });

        assert.ok(tail.chunks.length >= 1);

        const tailFull = tail.chunks.map(c => c.content).join('');
        assert.ok(!tailFull.includes(delivered),
            'tail should not contain the already-delivered code block prefix');

        for (const chunk of tail.chunks) {
            assert.ok(chunk.content.length <= budget,
                `tail chunk exceeds budget: ${chunk.content.length} > ${budget}`);
        }
    });
});

describe('replanTail — regression: long heading', () => {
    function uniqueHeadingMarkdown() {
        return '# ' + Array.from({ length: 120 }, (_, i) => `word${String(i).padStart(3, '0')}`).join(' ');
    }

    it('forced-split heading fragments must have distinct sourceRange.start cursors', () => {
        const md = uniqueHeadingMarkdown();
        const budget = 200;
        const original = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'forced-plain-text',
            transport: { safeTextBudget: budget },
        });

        assert.ok(original.chunks.length >= 3, `expected >= 3 chunks, got ${original.chunks.length}`);

        const starts = original.chunks.map(c => c.sourceRange.start);
        for (let i = 1; i < starts.length; i++) {
            assert.ok(
                !pathAndOffsetEqual(starts[i - 1], starts[i]),
                `heading chunks ${i - 1} and ${i} have identical start cursor: ` +
                `${JSON.stringify(starts[i])}`
            );
        }
    });

    it('replanTail must not re-send delivered prefix for forced-split heading', () => {
        const md = uniqueHeadingMarkdown();
        const budget = 200;
        const original = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'forced-plain-text',
            transport: { safeTextBudget: budget },
        });

        assert.ok(original.chunks.length >= 3, `expected >= 3 chunks, got ${original.chunks.length}`);

        const delivered = original.chunks[0].content;
        const tail = replan(md, original, 1, {
            preferredMode: 'plain-text',
            nextStrategy: 'forced-plain-text',
            transport: { safeTextBudget: budget },
            rejectReason: 'too-long',
        });

        const tailFull = tail.chunks.map(c => c.content).join('');
        assert.ok(
            !tailFull.includes(delivered),
            'tail should not contain the already-delivered heading prefix'
        );

        const starts = tail.chunks.map(c => c.sourceRange.start);
        for (let i = 1; i < starts.length; i++) {
            assert.ok(
                !pathAndOffsetEqual(starts[i - 1], starts[i]),
                `tail heading chunks ${i - 1} and ${i} have identical start cursor: ` +
                `${JSON.stringify(starts[i])}`
            );
        }
    });
});

// Helper: compare cursor path+offset
function pathAndOffsetEqual(a, b) {
    if (a.offsetUtf16 !== b.offsetUtf16) return false;
    if (a.path.length !== b.path.length) return false;
    for (let i = 0; i < a.path.length; i++) {
        if (a.path[i] !== b.path[i]) return false;
    }
    return true;
}

describe('replanTail — invalid-markup end-to-end', () => {
    it('rebuilds the undelivered rich-html tail as plain-text without duplicating delivered prefix', () => {
        const richSeq = Array.from({ length: 18 }, (_, i) => `**B${String(i).padStart(2, '0')}** text here.`).join(' ');
        const tailSeq = Array.from({ length: 18 }, (_, i) => `Tail ${String(i).padStart(2, '0')} here.`).join(' ');
        const md = richSeq + '\n\n' + tailSeq;
        const budget = 200;
        const original = plan(md, {
            preferredMode: 'auto',
            transport: { safeTextBudget: budget },
        });

        assert.ok(original.chunks.length >= 3, `expected multipart rich-html plan, got ${original.chunks.length} chunk(s)`);
        assert.equal(original.diagnostics.usedMode, 'rich-html');
        assert.equal(original.chunks[0].mode, 'rich-html');
        assert.match(original.chunks[0].content, /<b>B00<\/b>/);

        const deliveredTokens = Array.from(original.chunks[0].content.matchAll(/<b>(B\d{2})<\/b>/g), match => match[1]);
        const failedTokens = Array.from(original.chunks[1].content.matchAll(/<b>(B\d{2})<\/b>/g), match => match[1]);

        const tail = replan(md, original, 1, {
            preferredMode: 'plain-text',
            nextStrategy: 'preserve',
            transport: { safeTextBudget: budget },
            rejectReason: 'invalid-markup',
        });

        assert.ok(deliveredTokens.length >= 1, 'expected at least one delivered rich token in the first chunk');
        assert.ok(failedTokens.length >= 1, 'expected at least one undelivered rich token in the failed chunk');
        assert.ok(tail.chunks.length >= 1, 'expected non-empty replanned tail');
        assert.equal(tail.diagnostics.requestedMode, 'plain-text');
        assert.equal(tail.diagnostics.usedMode, 'plain-text');
        for (const chunk of tail.chunks) {
            assert.equal(chunk.mode, 'plain-text');
            assert.ok(chunk.content.length <= budget, `tail chunk exceeds budget: ${chunk.content.length} > ${budget}`);
            assert.ok(!chunk.content.includes('<b>'), `plain-text tail must not contain rich-html markup: ${JSON.stringify(chunk.content)}`);
        }

        const tailFull = tail.chunks.map(chunk => chunk.content).join('');
        for (const token of deliveredTokens) {
            assert.ok(!tailFull.includes(`${token} text here.`), `tail should not duplicate delivered token ${token} after markup degradation`);
        }
        assert.ok(
            failedTokens.some(token => tailFull.includes(`${token} text here.`)),
            'expected plain-text tail to keep content from the failed rich-html chunk'
        );
    });
});

describe('replanTail — strict sourceRange invariants', () => {
    it('same-strategy replan keeps exact sourceRange of the failed paragraph chunk', () => {
        const md = 'intro ' + 'one two three four. '.repeat(30);
        const original = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
        });

        assert.ok(original.chunks.length >= 3, `expected >= 3 chunks, got ${original.chunks.length}`);

        const tail = replan(md, original, 1, {
            preferredMode: 'plain-text',
            nextStrategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
            rejectReason: 'too-long',
        });

        assert.equal(tail.chunks[0].content, original.chunks[1].content);
        assert.deepEqual(tail.chunks[0].sourceRange, original.chunks[1].sourceRange);
    });

    it('same-strategy replan keeps exact sourceRange of the failed list continuation chunk', () => {
        const md = '- intro ' + 'one two three four. '.repeat(12) + '\n\n  second ' + 'five six seven eight. '.repeat(12);
        const original = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
        });

        assert.ok(original.chunks.length >= 4, `expected >= 4 chunks, got ${original.chunks.length}`);

        const tail = replan(md, original, 1, {
            preferredMode: 'plain-text',
            nextStrategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
            rejectReason: 'too-long',
        });

        assert.equal(tail.chunks[0].content, original.chunks[1].content);
        assert.deepEqual(tail.chunks[0].sourceRange, original.chunks[1].sourceRange);
    });
});

describe('replanTail — node-boundary sourceRange invariants', () => {
    it('same-strategy replan keeps exact sourceRange for code-block node-boundary cursors', () => {
        const md = '```js\n' + 'x=1;\n'.repeat(80) + '```';
        const original = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
        });

        assert.ok(original.chunks.length >= 3, `expected >= 3 chunks, got ${original.chunks.length}`);
        assert.deepEqual(original.chunks[1].sourceRange.start.path, [0]);
        assert.deepEqual(original.chunks[1].sourceRange.end.path, [0]);

        const tail = replan(md, original, 1, {
            preferredMode: 'plain-text',
            nextStrategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
            rejectReason: 'too-long',
        });

        assert.equal(tail.chunks[0].content, original.chunks[1].content);
        assert.deepEqual(tail.chunks[0].sourceRange, original.chunks[1].sourceRange);
    });

    it('keeps exact nested quote/list/paragraph sourceRange paths after replan', () => {
        const md = [
            '> - intro alpha beta gamma delta. alpha beta gamma delta. alpha beta gamma delta. alpha beta gamma delta. alpha beta gamma delta. alpha beta gamma delta. alpha beta gamma delta. alpha beta gamma delta.',
            '>   second para tail tail tail tail tail tail tail tail',
            '>',
            '> - next item short',
        ].join('\n');
        const original = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
        });

        assert.equal(original.chunks.length, 2);
        assert.deepEqual(original.chunks[1].sourceRange, {
            start: { path: [0, 0, 0, 0, 0], offsetUtf16: 190 },
            end: { path: [0, 0, 1, 0, 0], offsetUtf16: 15 },
        });

        const tail = replan(md, original, 1, {
            preferredMode: 'plain-text',
            nextStrategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
            rejectReason: 'too-long',
        });

        assert.equal(tail.chunks.length, 1);
        assert.equal(tail.chunks[0].content, '> -  delta.\n> second para tail tail tail tail tail tail tail tail\n> - next item short');
        assert.deepEqual(tail.chunks[0].sourceRange, {
            start: { path: [0, 0, 0, 0, 0], offsetUtf16: 190 },
            end: { path: [0, 0, 1, 0, 0], offsetUtf16: 15 },
        });
    });

    it('keeps exact UTF-16 offsets when replanning a Unicode-heavy paragraph tail', () => {
        const md = ('😀e\u0301Z ').repeat(50);
        const original = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
        });

        assert.equal(original.chunks.length, 2);
        assert.deepEqual(original.chunks[1].sourceRange, {
            start: { path: [0, 0], offsetUtf16: 198 },
            end: { path: [0, 0], offsetUtf16: 299 },
        });
        assert.equal(original.chunks[1].estimatedLength, original.chunks[1].content.length);

        const tail = replan(md, original, 1, {
            preferredMode: 'plain-text',
            nextStrategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
            rejectReason: 'too-long',
        });

        assert.equal(tail.chunks.length, 1);
        assert.equal(tail.chunks[0].content, original.chunks[1].content);
        assert.equal(tail.chunks[0].estimatedLength, tail.chunks[0].content.length);
        assert.deepEqual(tail.chunks[0].sourceRange, {
            start: { path: [0, 0], offsetUtf16: 198 },
            end: { path: [0, 0], offsetUtf16: 299 },
        });
    });
});

describe('replanTail — synthetic edge cases', () => {
    it('returns an empty tail when previous sourceRange points beyond normalized blocks', () => {
        const tail = replanTail({
            markdown: 'Hello',
            previousPlan: {
                chunks: [
                    {
                        sourceRange: {
                            start: { path: [5], offsetUtf16: 0 },
                            end: { path: [5], offsetUtf16: 0 },
                        },
                    },
                ],
            },
            failedChunkIndex: 0,
            preferredMode: 'auto',
            nextStrategy: 'preserve',
            transport,
            rejectReason: 'too-long',
        });

        assert.deepEqual(tail.chunks, []);
        assert.equal(tail.diagnostics.chunkCount, 0);
        assert.equal(tail.diagnostics.normalizedBlockCount, 0);
        assert.equal(tail.diagnostics.usedStrategy, 'preserve');
    });

    it('does not emit an empty chunk when trim lands exactly at the block end', () => {
        const tail = replanTail({
            markdown: 'Hello',
            previousPlan: {
                chunks: [
                    {
                        sourceRange: {
                            start: { path: [0, 0], offsetUtf16: 5 },
                            end: { path: [0, 0], offsetUtf16: 5 },
                        },
                    },
                ],
            },
            failedChunkIndex: 0,
            preferredMode: 'plain-text',
            nextStrategy: 'preserve',
            transport,
            rejectReason: 'too-long',
        });

        assert.deepEqual(tail.chunks, []);
        assert.equal(tail.diagnostics.chunkCount, 0);
        assert.equal(tail.diagnostics.plainTextLengthEstimate, 0);
    });

    it('gracefully handles stale child-path cursors instead of throwing', () => {
        assert.doesNotThrow(() => replanTail({
            markdown: 'Hello',
            previousPlan: {
                chunks: [
                    {
                        sourceRange: {
                            start: { path: [0, 9], offsetUtf16: 0 },
                            end: { path: [0, 9], offsetUtf16: 0 },
                        },
                    },
                ],
            },
            failedChunkIndex: 0,
            preferredMode: 'plain-text',
            nextStrategy: 'preserve',
            transport,
            rejectReason: 'too-long',
        }));
    });
});

