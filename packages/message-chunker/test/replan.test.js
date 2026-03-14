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

// =============== delivered prefix not resent ===============

describe('replanTail — delivered prefix not resent', () => {
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
