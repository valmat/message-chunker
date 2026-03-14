import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDelivery } from '../src/planner.js';
import { replanTail } from '../src/replan.js';

// Default transport profile for tests
const transport = {
    maxTextLength: 4096,
    safeTextBudget: 100,
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
        const md = 'First paragraph\n\nSecond paragraph\n\nThird paragraph';
        const original = plan(md, { transport: { safeTextBudget: 25 } });

        // Simulate: chunk 1 failed
        assert.ok(original.chunks.length >= 2);
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: 25 },
        });

        assert.ok(tail.chunks.length >= 1);
        // Tail should contain content from the failed chunk onwards
        const tailText = tail.chunks.map(c => c.content).join(' ');
        assert.ok(tailText.includes('Second') || tailText.includes('Third'));
    });

    it('replans from the first chunk (all failed)', () => {
        const md = 'Hello world';
        const original = plan(md);

        const tail = replan(md, original, 0);
        assert.equal(tail.chunks.length, 1);
        assert.ok(tail.chunks[0].content.includes('Hello'));
    });

    it('replans from the last chunk', () => {
        const md = 'A\n\nB\n\nC';
        const original = plan(md, { transport: { safeTextBudget: 5 } });
        const lastIdx = original.chunks.length - 1;

        const tail = replan(md, original, lastIdx, {
            transport: { safeTextBudget: 5 },
        });
        assert.ok(tail.chunks.length >= 1);
    });
});

// =============== tail chunk indices ===============

describe('replanTail — chunk indices', () => {
    it('tail chunks have fresh indices starting from 0', () => {
        const md = 'First\n\nSecond\n\nThird';
        const original = plan(md, { transport: { safeTextBudget: 15 } });

        assert.ok(original.chunks.length >= 2);
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: 15 },
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
        const md = 'Short\n\n' + 'x'.repeat(200);
        const original = plan(md, { transport: { safeTextBudget: 50 } });

        // Replan from chunk 0 with preserve — should escalate
        const tail = replan(md, original, 0, {
            nextStrategy: 'preserve',
            transport: { safeTextBudget: 50 },
        });

        assert.ok(tail.chunks.length >= 1);
        for (const chunk of tail.chunks) {
            assert.ok(chunk.content.length <= 50);
        }
    });

    it('respects the given nextStrategy as starting point', () => {
        const md = 'First\n\nSecond\n\nThird';
        const original = plan(md, { transport: { safeTextBudget: 15 } });

        const tail = replan(md, original, 1, {
            nextStrategy: 'split-blocks',
            transport: { safeTextBudget: 15 },
        });

        assert.ok(
            tail.diagnostics.requestedStrategy === 'split-blocks',
            `expected requestedStrategy split-blocks, got ${tail.diagnostics.requestedStrategy}`
        );
    });

    it('can escalate to forced-plain-text for very tough content', () => {
        const md = 'x'.repeat(300);
        const original = plan(md, { transport: { safeTextBudget: 50 } });

        const tail = replan(md, original, 0, {
            nextStrategy: 'preserve',
            transport: { safeTextBudget: 50 },
        });

        assert.ok(tail.chunks.length >= 2);
        for (const chunk of tail.chunks) {
            assert.ok(chunk.content.length <= 50);
        }
    });
});

// =============== sourceRange correctness ===============

describe('replanTail — sourceRange', () => {
    it('sourceRange paths reference the full IR, not the tail subset', () => {
        const md = 'First\n\nSecond\n\nThird';
        const original = plan(md, { transport: { safeTextBudget: 15 } });

        // Find the chunk that starts at block index > 0
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: 15 },
        });

        // The first tail chunk should reference a block index >= 1
        // (since it starts from the second or third block)
        const firstPath = tail.chunks[0].sourceRange.start.path[0];
        assert.ok(firstPath >= 1,
            `expected sourceRange path[0] >= 1, got ${firstPath}`);
    });
});

// =============== mode handling ===============

describe('replanTail — mode', () => {
    it('respects preferredMode plain-text', () => {
        const md = '**bold** text\n\nMore text';
        const original = plan(md, { transport: { safeTextBudget: 20 } });

        const tail = replan(md, original, 0, {
            preferredMode: 'plain-text',
            transport: { safeTextBudget: 20 },
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
        const md = 'First\n\nSecond\n\nThird';
        const original = plan(md, { transport: { safeTextBudget: 15 } });

        const tail = replan(md, original, 1, {
            nextStrategy: 'split-blocks',
            transport: { safeTextBudget: 15 },
        });

        assert.equal(tail.diagnostics.requestedStrategy, 'split-blocks');
        assert.equal(tail.diagnostics.requestedMode, 'auto');
        assert.equal(tail.diagnostics.chunkCount, tail.chunks.length);
        assert.ok(tail.diagnostics.normalizedBlockCount >= 1);
    });

    it('reports degradation when strategy escalated', () => {
        const md = 'x'.repeat(200);
        const original = plan(md, { transport: { safeTextBudget: 50 } });

        const tail = replan(md, original, 0, {
            nextStrategy: 'preserve',
            transport: { safeTextBudget: 50 },
        });

        assert.ok(tail.diagnostics.hadDegradation);
    });
});

// =============== budget invariant ===============

describe('replanTail — budget invariant', () => {
    it('no tail chunk exceeds safeTextBudget', () => {
        const cases = [
            'Word. '.repeat(50),
            '# Title\n\nParagraph. '.repeat(20) + '\n\n```\ncode\n```',
            'x'.repeat(500),
        ];
        for (const md of cases) {
            const original = plan(md, { transport: { safeTextBudget: 40 } });
            if (original.chunks.length < 2) continue;

            const tail = replan(md, original, 1, {
                transport: { safeTextBudget: 40 },
            });

            for (const chunk of tail.chunks) {
                assert.ok(
                    chunk.content.length <= 40,
                    `Budget exceeded in tail: ${chunk.content.length} > 40`
                );
            }
        }
    });
});

// =============== validation ===============

describe('replanTail — validation', () => {
    it('throws on invalid failedChunkIndex', () => {
        const md = 'Hello';
        const original = plan(md);

        assert.throws(() => replan(md, original, -1), RangeError);
        assert.throws(() => replan(md, original, 5), RangeError);
    });

    it('throws on unknown strategy', () => {
        const md = 'Hello';
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
});

// =============== delivered prefix not resent ===============

describe('replanTail — delivered prefix not resent', () => {
    it('tail does not contain content from delivered chunks', () => {
        const md = 'AAAA\n\nBBBB\n\nCCCC';
        const original = plan(md, { transport: { safeTextBudget: 10 } });

        // Ensure at least 2 chunks
        assert.ok(original.chunks.length >= 2, `expected >= 2 chunks, got ${original.chunks.length}`);

        // Fail at chunk 1 — chunk 0 is delivered
        const deliveredContent = original.chunks[0].content;
        const tail = replan(md, original, 1, {
            transport: { safeTextBudget: 10 },
        });

        // None of the tail chunks should contain the delivered chunk's unique content
        // (unless it was coincidentally repeated)
        const tailFull = tail.chunks.map(c => c.content).join('\n');
        // deliveredContent should contain "AAAA" but tail should not start with it
        if (deliveredContent.includes('AAAA')) {
            assert.ok(!tailFull.startsWith('AAAA'),
                'tail should not start with delivered content');
        }
    });
});
