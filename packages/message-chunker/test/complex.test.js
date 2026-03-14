import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planDelivery } from '../src/planner.js';
import { replanTail } from '../src/replan.js';

// Default transport profile
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

// ========================================================
// §21.2 Golden tests
// ========================================================

describe('golden — single short message', () => {
    it('one chunk, rich-html, preserve strategy', () => {
        const md = 'Hello **world**!';
        const r = plan(md);
        assert.equal(r.chunks.length, 1);
        assert.equal(r.chunks[0].mode, 'rich-html');
        assert.equal(r.chunks[0].index, 0);
        assert.equal(r.chunks[0].total, 1);
        assert.equal(r.diagnostics.usedStrategy, 'preserve');
        assert.ok(r.chunks[0].content.includes('<b>world</b>'));
    });
});

describe('golden — multi-block split', () => {
    it('three long paragraphs split into chunks', () => {
        const p1 = 'Alpha. '.repeat(20);  // ~140 chars
        const p2 = 'Bravo. '.repeat(20);
        const p3 = 'Charlie. '.repeat(20);
        const md = p1.trim() + '\n\n' + p2.trim() + '\n\n' + p3.trim();
        const r = plan(md, { transport: { safeTextBudget: 250 } });
        assert.ok(r.chunks.length >= 2);
        assert.ok(r.chunks[0].content.includes('Alpha'));
        assert.ok(r.chunks[r.chunks.length - 1].content.includes('Charlie'));
        for (let i = 0; i < r.chunks.length; i++) {
            assert.equal(r.chunks[i].index, i);
            assert.equal(r.chunks[i].total, r.chunks.length);
        }
    });
});

describe('golden — plain-text concatenation preserves content', () => {
    it('concatenated plain-text chunks cover all source text', () => {
        const md = '# Title\n\n' + 'Paragraph one. '.repeat(15) + '\n\n' +
            'Paragraph two. '.repeat(15) + '\n\n- item A\n- item B';
        const r = plan(md, {
            preferredMode: 'plain-text',
            transport: { safeTextBudget: 250 },
        });
        const full = r.chunks.map(c => c.content).join('\n\n');
        assert.ok(full.includes('Title'));
        assert.ok(full.includes('Paragraph one'));
        assert.ok(full.includes('Paragraph two'));
        assert.ok(full.includes('item A'));
        assert.ok(full.includes('item B'));
    });
});

describe('golden — sourceRange stability', () => {
    it('same input produces same sourceRanges', () => {
        const md = 'A'.repeat(150) + '\n\n' + 'B'.repeat(150) + '\n\n' + 'C'.repeat(150);
        const r1 = plan(md, { transport: { safeTextBudget: 200 } });
        const r2 = plan(md, { transport: { safeTextBudget: 200 } });
        assert.deepEqual(
            r1.chunks.map(c => c.sourceRange),
            r2.chunks.map(c => c.sourceRange),
        );
    });
});

// ========================================================
// §21.3 Property-like tests (invariants)
// ========================================================

describe('invariant — budget never exceeded', () => {
    const budgets = [200, 300, 500, 1000];
    const inputs = [
        'Simple text.',
        '**Bold** and *italic* and `code` and [link](http://example.com)',
        'A'.repeat(2000),
        'Word. '.repeat(200),
        '# Title\n\n' + 'Para. '.repeat(80) + '\n\n- item1\n- item2\n\n> quote text here\n\n```\ncode line\n```',
        '```js\n' + 'x = 1;\n'.repeat(100) + '```',
        '> ' + 'Quoted sentence. '.repeat(60),
    ];
    for (const budget of budgets) {
        for (const md of inputs) {
            it(`budget=${budget}, input len=${md.length}`, () => {
                const r = plan(md, { transport: { safeTextBudget: budget } });
                for (const chunk of r.chunks) {
                    assert.ok(
                        chunk.content.length <= budget,
                        `Chunk exceeds budget: ${chunk.content.length} > ${budget}, strategy=${r.diagnostics.usedStrategy}`
                    );
                }
            });
        }
    }
});

describe('invariant — planDelivery always returns a result', () => {
    const inputs = [
        '',
        'Hello',
        'x'.repeat(10000),
        '```\n' + 'line\n'.repeat(500) + '```',
        '> ' + 'q'.repeat(5000),
        '- ' + 'item '.repeat(1000),
    ];
    for (const md of inputs) {
        it(`input len=${md.length}`, () => {
            const r = plan(md, { transport: { safeTextBudget: 200 } });
            assert.ok(r);
            assert.ok(Array.isArray(r.chunks));
            assert.ok(r.diagnostics);
        });
    }
});

describe('invariant — forced-plain-text always produces a plan', () => {
    const inputs = [
        'x',
        'x'.repeat(10000),
        '\u{1F600}'.repeat(200),  // emoji
        '`' + 'x'.repeat(1000) + '`',
    ];
    for (const md of inputs) {
        it(`input len=${md.length}`, () => {
            const r = plan(md, {
                strategy: 'forced-plain-text',
                transport: { safeTextBudget: 200 },
            });
            assert.ok(r.chunks.length >= 1);
            for (const chunk of r.chunks) {
                assert.ok(chunk.content.length <= 200);
            }
        });
    }
});

describe('invariant — replan tail does not include delivered prefix', () => {
    it('multi-chunk plan: tail starts after delivered chunks', () => {
        const md = 'UNIQUE_FIRST '.repeat(20) + '\n\n' +
            'UNIQUE_SECOND '.repeat(20) + '\n\n' +
            'UNIQUE_THIRD '.repeat(20) + '\n\n' +
            'UNIQUE_FOURTH '.repeat(20);
        const original = plan(md, { transport: { safeTextBudget: 250 } });

        if (original.chunks.length < 3) return; // skip if too few chunks

        // Fail at chunk 2 — chunks 0,1 delivered
        const tail = replan(md, original, 2, { transport: { safeTextBudget: 250 } });
        const tailFull = tail.chunks.map(c => c.content).join('\n');

        // Delivered unique tokens should not appear in tail
        if (original.chunks[0].content.includes('UNIQUE_FIRST')) {
            assert.ok(!tailFull.includes('UNIQUE_FIRST'));
        }
    });
});

describe('invariant — plain-text concatenation preserves significant text', () => {
    it('all words from source appear in chunked output', () => {
        const md = 'Alpha bravo charlie. '.repeat(10) + 'Delta echo foxtrot.\n\n' +
            'Golf hotel india. '.repeat(10);
        const r = plan(md, {
            preferredMode: 'plain-text',
            transport: { safeTextBudget: 200 },
        });
        const full = r.chunks.map(c => c.content).join(' ');
        for (const word of ['Alpha', 'bravo', 'charlie', 'Delta', 'echo', 'foxtrot', 'Golf', 'hotel', 'india']) {
            assert.ok(full.includes(word), `missing word: ${word}`);
        }
    });
});

// ========================================================
// §21.4 Mandatory nasty cases
// ========================================================

describe('nasty — giant paragraph', () => {
    it('splits correctly', () => {
        const md = 'Word. '.repeat(2000);
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 10);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });
});

describe('nasty — giant code block', () => {
    it('splits with balanced fences', () => {
        const md = '```js\n' + 'x = 1;\n'.repeat(500) + '```';
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 2);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
            const fenceCount = (chunk.content.match(/```/g) || []).length;
            assert.equal(fenceCount % 2, 0, `unbalanced fences: ${chunk.content.slice(0, 60)}...`);
        }
    });
});

describe('nasty — super long line without spaces', () => {
    it('forced split handles it', () => {
        const md = 'x'.repeat(5000);
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.equal(r.chunks.length, 25);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });
});

describe('nasty — giant URL', () => {
    it('link with very long href', () => {
        const longUrl = 'https://example.com/' + 'a'.repeat(500);
        const md = `[click here](${longUrl})`;
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 1);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });
});

describe('nasty — giant inline code', () => {
    it('atomic in rich-html, forces escalation', () => {
        const md = '`' + 'x'.repeat(500) + '`';
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 1);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
        // Should have escalated past rich-html strategies
        assert.ok(
            r.diagnostics.usedStrategy === 'plain-text' ||
            r.diagnostics.usedStrategy === 'forced-plain-text',
        );
    });
});

describe('nasty — broken markdown', () => {
    it('unclosed formatting', () => {
        const md = '**unclosed bold and *also italic\n\n' + 'Next paragraph. '.repeat(15);
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 1);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });

    it('mismatched fences', () => {
        const md = '```\ncode without closing fence\n\n' + 'Another paragraph. '.repeat(15);
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 1);
    });

    it('empty headings and lists', () => {
        const md = '#\n\n-\n\n>\n\nText.';
        const r = plan(md);
        assert.ok(r.chunks.length >= 1);
    });
});

describe('nasty — raw HTML inside markdown', () => {
    it('HTML block escaped in rich-html mode', () => {
        const md = '<div class="test">Hello</div>\n\nNormal paragraph.';
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 1);
        // No raw <div> in output
        if (r.chunks[0].mode === 'rich-html') {
            assert.ok(!r.chunks[0].content.includes('<div'));
        }
    });

    it('inline HTML escaped', () => {
        const md = 'Text with <b>html</b> inside.';
        const r = plan(md);
        // The <b> from raw HTML should be escaped, not treated as formatting
        assert.ok(r.chunks[0].content.includes('&lt;b&gt;'));
    });
});

describe('nasty — emoji, ZWJ and combining characters', () => {
    it('emoji repeat splits correctly', () => {
        const md = '\u{1F600}'.repeat(200); // 😀 x200 = 400 code units
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 2);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
            // No orphaned surrogates
            for (let i = 0; i < chunk.content.length; i++) {
                const code = chunk.content.charCodeAt(i);
                if (code >= 0xD800 && code <= 0xDBFF) {
                    assert.ok(i + 1 < chunk.content.length, 'orphaned high surrogate');
                    const next = chunk.content.charCodeAt(i + 1);
                    assert.ok(next >= 0xDC00 && next <= 0xDFFF, 'invalid low surrogate');
                }
            }
        }
    });

    it('ZWJ sequence in text', () => {
        // Family emoji: 👨‍👩‍👧‍👦 (ZWJ sequence)
        const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
        const md = ('Hello ' + family + ' ').repeat(30);
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 1);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });

    it('combining diacritics', () => {
        // é = e + combining acute accent (U+0301)
        const md = ('e\u0301 ').repeat(100);
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });
});

describe('nasty — nested lists', () => {
    it('deeply nested list', () => {
        const md = '- level 1\n  - level 2\n    - level 3\n      - level 4';
        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 1);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });

    it('list with many items', () => {
        const items = Array.from({ length: 50 }, (_, i) => `- Item number ${i + 1} with some padding text`).join('\n');
        const r = plan(items, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 1);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });
});

describe('nasty — combinations of quote + code + link', () => {
    it('complex mixed content', () => {
        const md = [
            '> Quote with **bold** and `code`. '.repeat(3),
            '',
            '```python',
            'def hello():',
            '    print("world")',
            '```',
            '',
            'Paragraph with [a link](https://example.com/long/path/to/resource). '.repeat(3),
            '',
            '> Another quote with a [link](https://example.com). '.repeat(3),
            '',
            '- list item with `code` and some extra text here',
            '- list item with **bold** and some extra text here',
        ].join('\n');

        const r = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(r.chunks.length >= 1);
        for (const chunk of r.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });
});

describe('nasty — reject in the middle of chunk sequence', () => {
    it('replan after reject at chunk 2', () => {
        const md = 'Para1. '.repeat(20) + '\n\n' +
            'Para2. '.repeat(20) + '\n\n' +
            'Para3. '.repeat(20) + '\n\n' +
            'Para4. '.repeat(20) + '\n\n' +
            'Para5. '.repeat(20);
        const original = plan(md, { transport: { safeTextBudget: 200 } });

        assert.ok(original.chunks.length >= 4, `expected >= 4 chunks, got ${original.chunks.length}`);

        // Reject at chunk 2
        const tail = replan(md, original, 2, {
            transport: { safeTextBudget: 200 },
        });

        assert.ok(tail.chunks.length >= 1);
        // Tail indices start at 0
        assert.equal(tail.chunks[0].index, 0);

        // Budget respected
        for (const chunk of tail.chunks) {
            assert.ok(chunk.content.length <= 200);
        }

        // Delivered content (chunks 0,1) not in tail
        const delivered = original.chunks.slice(0, 2).map(c => c.content).join('|');
        const tailContent = tail.chunks.map(c => c.content).join('|');
        if (delivered.includes('Para1')) {
            assert.ok(!tailContent.includes('Para1'));
        }
    });

    it('replan with more aggressive strategy after reject', () => {
        const md = '**Bold text here. '.repeat(15) + '**\n\n' +
            'More content here. '.repeat(15) + '\n\n' +
            'Even more content here. '.repeat(15);
        const original = plan(md, { transport: { safeTextBudget: 200 } });

        if (original.chunks.length < 2) return;

        // Replan with forced-plain-text
        const tail = replan(md, original, 1, {
            nextStrategy: 'forced-plain-text',
            transport: { safeTextBudget: 200 },
        });

        assert.ok(tail.chunks.length >= 1);
        assert.equal(tail.diagnostics.usedStrategy, 'forced-plain-text');
        for (const chunk of tail.chunks) {
            assert.equal(chunk.mode, 'plain-text');
            assert.ok(chunk.content.length <= 200);
        }
    });
});

// ========================================================
// Determinism
// ========================================================

describe('determinism — complex input', () => {
    it('same complex input produces identical plans', () => {
        const md = '# Title\n\n**Bold** and *italic*.\n\n```js\nconsole.log("hi");\n```\n\n- item 1\n- item 2\n\n> Quote here.\n\n[Link](https://example.com)';
        const r1 = plan(md, { transport: { safeTextBudget: 200 } });
        const r2 = plan(md, { transport: { safeTextBudget: 200 } });

        assert.equal(r1.chunks.length, r2.chunks.length);
        for (let i = 0; i < r1.chunks.length; i++) {
            assert.equal(r1.chunks[i].content, r2.chunks[i].content);
            assert.equal(r1.chunks[i].mode, r2.chunks[i].mode);
            assert.deepEqual(r1.chunks[i].sourceRange, r2.chunks[i].sourceRange);
        }
        assert.deepEqual(r1.diagnostics, r2.diagnostics);
    });
});
