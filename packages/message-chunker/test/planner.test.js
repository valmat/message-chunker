import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDelivery } from '../src/planner.js';

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

// =============== empty input ===============

describe('planner — empty input', () => {
    it('empty string returns empty chunks', () => {
        const result = plan('');
        assert.equal(result.chunks.length, 0);
        assert.equal(result.diagnostics.chunkCount, 0);
    });

    it('whitespace-only returns empty chunks', () => {
        const result = plan('   \n\n   ');
        assert.equal(result.chunks.length, 0);
    });
});

// =============== preserve strategy ===============

describe('planner — preserve', () => {
    it('short message fits in one chunk', () => {
        const result = plan('Hello world');
        assert.equal(result.chunks.length, 1);
        assert.equal(result.chunks[0].content, 'Hello world');
        assert.equal(result.chunks[0].mode, 'rich-html');
        assert.equal(result.chunks[0].index, 0);
        assert.equal(result.chunks[0].total, 1);
        assert.equal(result.diagnostics.usedStrategy, 'preserve');
    });

    it('rich-html with formatting', () => {
        const result = plan('**bold** and *italic*');
        assert.equal(result.chunks.length, 1);
        assert.ok(result.chunks[0].content.includes('<b>bold</b>'));
        assert.ok(result.chunks[0].content.includes('<i>italic</i>'));
    });

    it('preferredMode plain-text', () => {
        const result = plan('**bold**', { preferredMode: 'plain-text' });
        assert.equal(result.chunks[0].mode, 'plain-text');
        assert.equal(result.chunks[0].content, 'bold');
    });

    it('transport without rich-html falls back to plain-text', () => {
        const result = plan('**bold**', {
            transport: { supportsRichHtml: false },
        });
        assert.equal(result.chunks[0].mode, 'plain-text');
        assert.equal(result.chunks[0].content, 'bold');
    });
});

// =============== strategy escalation ===============

describe('planner — strategy escalation', () => {
    it('escalates from preserve to split-blocks', () => {
        const md = 'First paragraph\n\nSecond paragraph';
        const result = plan(md, { transport: { safeTextBudget: 20 } });
        assert.equal(result.chunks.length, 2);
        assert.equal(result.diagnostics.usedStrategy, 'split-blocks');
    });

    it('escalates past split-blocks-soft when atomic inline too large', () => {
        // Giant inline code in rich-html is atomic — can't split in split-blocks-soft
        const md = '`' + 'x'.repeat(60) + '`';
        const result = plan(md, { transport: { safeTextBudget: 30 } });
        assert.ok(result.chunks.length >= 2);
        assert.ok(
            result.diagnostics.usedStrategy === 'plain-text' ||
            result.diagnostics.usedStrategy === 'forced-plain-text',
            `expected plain-text or forced-plain-text, got ${result.diagnostics.usedStrategy}`
        );
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 30, `chunk too long: ${chunk.content.length}`);
        }
    });

    it('starting from a more aggressive strategy skips earlier ones', () => {
        const md = 'First\n\nSecond';
        const result = plan(md, {
            strategy: 'split-blocks',
            transport: { safeTextBudget: 20 },
        });
        assert.equal(result.diagnostics.usedStrategy, 'split-blocks');
        assert.equal(result.diagnostics.requestedStrategy, 'split-blocks');
    });
});

// =============== split-blocks ===============

describe('planner — split-blocks', () => {
    it('splits by top-level blocks', () => {
        const md = 'Paragraph one\n\nParagraph two\n\nParagraph three';
        const result = plan(md, { transport: { safeTextBudget: 30 } });
        assert.ok(result.chunks.length >= 2);
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 30);
        }
    });

    it('packs multiple blocks into one chunk when possible', () => {
        const md = 'Short\n\nAlso short';
        const result = plan(md, { transport: { safeTextBudget: 50 } });
        assert.equal(result.chunks.length, 1);
        assert.ok(result.chunks[0].content.includes('Short'));
        assert.ok(result.chunks[0].content.includes('Also short'));
    });

    it('greedy: maximal prefix, not balanced split', () => {
        const md = 'A\n\nBB\n\nCCC';
        // Budget 8: "A\n\nBB" = 6 fits, adding "\n\nCCC" = 11 doesn't
        const result = plan(md, { transport: { safeTextBudget: 8 } });
        assert.equal(result.chunks.length, 2);
        assert.ok(result.chunks[0].content.includes('A'));
        assert.ok(result.chunks[0].content.includes('BB'));
        assert.equal(result.chunks[1].content, 'CCC');
    });
});

// =============== split-blocks-soft ===============

describe('planner — split-blocks-soft', () => {
    it('splits a long paragraph', () => {
        const sentence = 'This is a sentence. ';
        const md = sentence.repeat(10); // ~200 chars
        const result = plan(md, { transport: { safeTextBudget: 50 } });
        assert.ok(result.chunks.length >= 2);
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 50, `chunk ${chunk.index} too long: ${chunk.content.length}`);
        }
    });

    it('code_block stays atomic in rich-html', () => {
        const code = '```\n' + 'x'.repeat(200) + '\n```';
        const md = 'Before\n\n' + code;
        // In rich-html, code_block is atomic. If budget is small, must escalate.
        const result = plan(md, {
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 50 },
        });
        // Should escalate to plain-text or forced-plain-text
        assert.ok(
            result.diagnostics.usedStrategy === 'plain-text' ||
            result.diagnostics.usedStrategy === 'forced-plain-text'
        );
    });
});

// =============== plain-text strategy ===============

describe('planner — plain-text strategy', () => {
    it('code_block can be split in plain-text', () => {
        const code = '```\n' + 'line\n'.repeat(40) + '```';
        const result = plan(code, {
            strategy: 'plain-text',
            transport: { safeTextBudget: 60 },
        });
        assert.ok(result.chunks.length >= 2);
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 60);
            assert.equal(chunk.mode, 'plain-text');
        }
    });
});

// =============== forced-plain-text ===============

describe('planner — forced-plain-text', () => {
    it('splits very long text without spaces', () => {
        const md = 'x'.repeat(250);
        const result = plan(md, { transport: { safeTextBudget: 50 } });
        assert.ok(result.chunks.length >= 5);
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 50);
        }
    });

    it('prefers \\n\\n over \\n over whitespace', () => {
        const md = 'First block\n\nSecond block\nthird line word';
        const result = plan(md, { transport: { safeTextBudget: 25 } });
        // First chunk should split at \n\n
        assert.equal(result.chunks[0].content, 'First block');
    });

    it('handles surrogate pairs correctly', () => {
        const emoji = '\uD83D\uDE00'; // 😀
        const md = emoji.repeat(30); // 60 code units
        const result = plan(md, { transport: { safeTextBudget: 10 } });
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 10);
            // No orphaned surrogates
            for (let i = 0; i < chunk.content.length; i++) {
                const code = chunk.content.charCodeAt(i);
                if (code >= 0xD800 && code <= 0xDBFF) {
                    // High surrogate must be followed by low surrogate
                    assert.ok(i + 1 < chunk.content.length);
                    const next = chunk.content.charCodeAt(i + 1);
                    assert.ok(next >= 0xDC00 && next <= 0xDFFF);
                }
            }
        }
    });

    it('code block split keeps balanced fences', () => {
        const code = '```js\n' + 'x = 1;\n'.repeat(20) + '```';
        const result = plan(code, {
            strategy: 'forced-plain-text',
            transport: { safeTextBudget: 50 },
        });
        for (const chunk of result.chunks) {
            const opens = (chunk.content.match(/```/g) || []).length;
            assert.equal(opens % 2, 0, `unbalanced fences in chunk: ${chunk.content.slice(0, 40)}...`);
        }
    });
});

// =============== chunk structure ===============

describe('planner — chunk structure', () => {
    it('chunks have correct index and total', () => {
        const md = 'A\n\nB\n\nC';
        const result = plan(md, { transport: { safeTextBudget: 5 } });
        for (let i = 0; i < result.chunks.length; i++) {
            assert.equal(result.chunks[i].index, i);
            assert.equal(result.chunks[i].total, result.chunks.length);
        }
    });

    it('estimatedLength matches content.length', () => {
        const result = plan('Hello world');
        assert.equal(result.chunks[0].estimatedLength, result.chunks[0].content.length);
    });

    it('sourceRange has start and end cursors', () => {
        const result = plan('Hello world');
        const sr = result.chunks[0].sourceRange;
        assert.ok(sr.start);
        assert.ok(sr.end);
        assert.ok(Array.isArray(sr.start.path));
        assert.ok(typeof sr.start.offsetUtf16 === 'number');
    });
});

// =============== diagnostics ===============

describe('planner — diagnostics', () => {
    it('reports correct diagnostics for simple case', () => {
        const md = 'Hello world';
        const result = plan(md);
        const d = result.diagnostics;
        assert.equal(d.sourceLength, md.length);
        assert.equal(d.normalizedBlockCount, 1);
        assert.equal(d.chunkCount, 1);
        assert.equal(d.requestedStrategy, 'preserve');
        assert.equal(d.usedStrategy, 'preserve');
        assert.equal(d.requestedMode, 'auto');
        assert.equal(d.usedMode, 'rich-html');
        assert.equal(d.hadDegradation, false);
        assert.equal(d.degradedToPlainText, false);
        assert.deepEqual(d.splitBlockTypes, []);
    });

    it('reports degradation when strategy escalated', () => {
        const md = 'A'.repeat(200);
        const result = plan(md, { transport: { safeTextBudget: 50 } });
        assert.ok(result.diagnostics.hadDegradation);
    });

    it('reports degradedToPlainText', () => {
        // Giant code block is atomic in rich-html → forces plain-text degradation
        const md = '```\n' + 'x'.repeat(200) + '\n```';
        const result = plan(md, {
            preferredMode: 'rich-html',
            transport: { safeTextBudget: 50 },
        });
        assert.equal(result.diagnostics.degradedToPlainText, true);
    });

    it('reports splitBlockTypes', () => {
        const sentence = 'Word. ';
        const md = sentence.repeat(30); // long paragraph
        const result = plan(md, { transport: { safeTextBudget: 50 } });
        if (result.diagnostics.usedStrategy === 'split-blocks-soft' ||
            result.diagnostics.usedStrategy === 'plain-text') {
            assert.ok(result.diagnostics.splitBlockTypes.includes('paragraph'));
        }
    });
});

// =============== budget invariant ===============

describe('planner — budget invariant', () => {
    it('no chunk exceeds safeTextBudget', () => {
        const cases = [
            'Simple text',
            '**Bold** and *italic* and `code`',
            'A'.repeat(500),
            'Word. '.repeat(100),
            '# Title\n\n' + 'Para. '.repeat(50) + '\n\n- item1\n- item2\n\n> quote\n\n```\ncode\n```',
        ];
        for (const md of cases) {
            const result = plan(md, { transport: { safeTextBudget: 40 } });
            for (const chunk of result.chunks) {
                assert.ok(
                    chunk.content.length <= 40,
                    `Budget exceeded: ${chunk.content.length} > 40 for strategy ${result.diagnostics.usedStrategy}: "${chunk.content.slice(0, 50)}..."`
                );
            }
        }
    });
});

// =============== determinism ===============

describe('planner — determinism', () => {
    it('same input produces same plan', () => {
        const md = '# Title\n\nParagraph with **bold**.\n\n- item 1\n- item 2';
        const r1 = plan(md, { transport: { safeTextBudget: 30 } });
        const r2 = plan(md, { transport: { safeTextBudget: 30 } });
        assert.equal(r1.chunks.length, r2.chunks.length);
        for (let i = 0; i < r1.chunks.length; i++) {
            assert.equal(r1.chunks[i].content, r2.chunks[i].content);
            assert.equal(r1.chunks[i].mode, r2.chunks[i].mode);
        }
    });
});
