import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertChunksWithinBudget, planDelivery } from '../src/planner.js';

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
        // Two paragraphs: each ~150 chars, together ~302 > 200
        const md = 'First sentence here. '.repeat(8) + '\n\n' + 'Second sentence here. '.repeat(8);
        const result = plan(md, { transport: { safeTextBudget: 200 } });
        assert.equal(result.chunks.length, 2);
        assert.equal(result.diagnostics.usedStrategy, 'split-blocks');
    });

    it('escalates past split-blocks-soft when atomic inline too large', () => {
        // Giant inline code in rich-html is atomic — can't split in split-blocks-soft
        const md = '`' + 'x'.repeat(250) + '`';
        const result = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(result.chunks.length >= 2);
        assert.ok(
            result.diagnostics.usedStrategy === 'plain-text' ||
            result.diagnostics.usedStrategy === 'forced-plain-text',
            `expected plain-text or forced-plain-text, got ${result.diagnostics.usedStrategy}`
        );
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 200, `chunk too long: ${chunk.content.length}`);
        }
    });

    it('starting from a more aggressive strategy skips earlier ones', () => {
        const md = 'First sentence here. '.repeat(8) + '\n\n' + 'Second sentence here. '.repeat(8);
        const result = plan(md, {
            strategy: 'split-blocks',
            transport: { safeTextBudget: 200 },
        });
        assert.equal(result.diagnostics.usedStrategy, 'split-blocks');
        assert.equal(result.diagnostics.requestedStrategy, 'split-blocks');
    });
});

// =============== split-blocks ===============

describe('planner — split-blocks', () => {
    it('splits by top-level blocks', () => {
        const p = 'Paragraph content here. '.repeat(6); // ~144 chars each
        const md = p + '\n\n' + p + '\n\n' + p;
        const result = plan(md, { transport: { safeTextBudget: 250 } });
        assert.ok(result.chunks.length >= 2);
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 250);
        }
    });

    it('packs multiple blocks into one chunk when possible', () => {
        const md = 'Short\n\nAlso short';
        const result = plan(md, { transport: { safeTextBudget: 500 } });
        assert.equal(result.chunks.length, 1);
        assert.ok(result.chunks[0].content.includes('Short'));
        assert.ok(result.chunks[0].content.includes('Also short'));
    });

    it('greedy: maximal prefix, not balanced split', () => {
        // A=80, B=80, C=80. AB = 80+2+80 = 162 < 200. ABC = 162+2+80 = 244 > 200.
        const md = 'A'.repeat(80) + '\n\n' + 'B'.repeat(80) + '\n\n' + 'C'.repeat(80);
        const result = plan(md, { transport: { safeTextBudget: 200 } });
        assert.equal(result.chunks.length, 2);
        assert.ok(result.chunks[0].content.includes('A'.repeat(80)));
        assert.ok(result.chunks[0].content.includes('B'.repeat(80)));
        assert.equal(result.chunks[1].content, 'C'.repeat(80));
    });
});

// =============== split-blocks-soft ===============

describe('planner — split-blocks-soft', () => {
    it('splits a long paragraph', () => {
        const sentence = 'This is a sentence. ';
        const md = sentence.repeat(30); // ~600 chars
        const result = plan(md, { transport: { safeTextBudget: 250 } });
        assert.ok(result.chunks.length >= 2);
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 250, `chunk ${chunk.index} too long: ${chunk.content.length}`);
        }
    });

    it('preserves markdown line breaks when paragraph is split', () => {
        const md = 'alpha\nbeta  \ngamma ' + 'tail '.repeat(60);
        const result = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
        });

        assert.equal(result.diagnostics.usedStrategy, 'split-blocks-soft');
        assert.equal(result.diagnostics.usedMode, 'plain-text');
        assert.ok(result.chunks.length >= 2, `expected split, got ${result.chunks.length} chunk(s)`);
        assert.match(result.chunks[0].content, /alpha\nbeta\ngamma/);

        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 200, `chunk ${chunk.index} too long: ${chunk.content.length}`);
        }
    });

    it('code_block stays atomic in rich-html', () => {
        const code = '```\n' + 'x'.repeat(300) + '\n```';
        const md = 'Before\n\n' + code;
        // In rich-html, code_block is atomic. If budget is small, must escalate.
        const result = plan(md, {
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 250 },
        });
        // Should escalate to plain-text or forced-plain-text
        assert.ok(
            result.diagnostics.usedStrategy === 'plain-text' ||
            result.diagnostics.usedStrategy === 'forced-plain-text'
        );
    });

    it('rich-html prefers a sentence boundary inside the fitting prefix', () => {
        const md = [
            'Это один очень длинный абзац для демонстрации split-blocks-soft.',
            'Он специально состоит из многих предложений.',
            'Библиотека сначала пытается сохранить всё целиком.',
            'Потом пытается делить по блокам.',
            'Но блок здесь один, поэтому ей приходится делить внутри абзаца.',
            'Сначала она ищет конец предложения.',
            'Потом точку с запятой; потом запятую, а затем пробел.',
            'И только в самом крайнем случае делает принудительный Unicode-safe разрез.',
        ].join(' ');

        const result = plan(md, { transport: { safeTextBudget: 240 } });

        assert.equal(result.diagnostics.usedStrategy, 'split-blocks-soft');
        assert.equal(result.diagnostics.usedMode, 'rich-html');
        assert.equal(result.chunks.length, 2);
        assert.deepEqual(
            result.chunks.map(chunk => chunk.content),
            [
                [
                    'Это один очень длинный абзац для демонстрации split-blocks-soft.',
                    'Он специально состоит из многих предложений.',
                    'Библиотека сначала пытается сохранить всё целиком.',
                    'Потом пытается делить по блокам.',
                ].join(' '),
                [
                    'Но блок здесь один, поэтому ей приходится делить внутри абзаца.',
                    'Сначала она ищет конец предложения.',
                    'Потом точку с запятой; потом запятую, а затем пробел.',
                    'И только в самом крайнем случае делает принудительный Unicode-safe разрез.',
                ].join(' '),
            ]
        );
    });

    it('rich-html falls back to whitespace when no sentence boundary exists', () => {
        const segment = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron ';
        const tail = 'pi rho sigma tau upsilon phi chi psi omega';
        const md = (segment + tail + ' ').repeat(4).trim();

        const result = plan(md, { transport: { safeTextBudget: 220 } });

        assert.equal(result.diagnostics.usedStrategy, 'split-blocks-soft');
        assert.equal(result.diagnostics.usedMode, 'rich-html');
        assert.ok(result.chunks.length >= 2);
        assert.equal(
            result.chunks[0].content,
            [
                segment + tail,
                segment + 'pi rho sigma',
            ].join(' ')
        );
        assert.match(result.chunks[1].content, /^tau upsilon /);
        assert.doesNotMatch(result.chunks[0].content, /sigm$/);
        assert.doesNotMatch(result.chunks[1].content, /^a /);
    });

    it('rich-html keeps rendered-length fitting correct for escaped text while still choosing a soft boundary', () => {
        const segment = 'alpha & beta < gamma > delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron ';
        const tail = 'pi & rho < sigma > tau upsilon';
        const md = (segment + tail + ' ').repeat(4).trim();

        const result = plan(md, { transport: { safeTextBudget: 220 } });

        assert.equal(result.diagnostics.usedStrategy, 'split-blocks-soft');
        assert.equal(result.diagnostics.usedMode, 'rich-html');
        assert.ok(result.chunks.length >= 2);
        assert.equal(
            result.chunks[0].content,
            [
                'alpha &amp; beta &lt; gamma &gt; delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron',
                'pi &amp; rho &lt; sigma &gt; tau upsilon alpha &amp; beta &lt; gamma &gt; delta epsilon zeta eta theta iota kappa lambda',
            ].join(' ')
        );
        assert.match(result.chunks[1].content, /^mu nu xi omicron /);
        assert.ok(result.chunks[0].content.endsWith('lambda'));
        assert.ok(!result.chunks[0].content.endsWith('&'));
    });

    it('rich-html uses forced split only when no softer boundary exists', () => {
        const md = 'абвгдежзийклмнопрстуфхцчшщъыьэюя'.repeat(8);

        const result = plan(md, { transport: { safeTextBudget: 220 } });

        assert.equal(result.diagnostics.usedStrategy, 'split-blocks-soft');
        assert.equal(result.diagnostics.usedMode, 'rich-html');
        assert.equal(result.chunks.length, 2);
        assert.equal(result.chunks[0].content.length, 220);
        assert.equal(result.chunks[1].content, 'ьэюяабвгдежзийклмнопрстуфхцчшщъыьэюя');
    });
});

// =============== plain-text strategy ===============

describe('planner — plain-text strategy', () => {
    it('long heading degrades to plain-text before forced-plain-text', () => {
        const md = '# ' + 'word '.repeat(100);
        const result = plan(md, {
            preferredMode: 'rich-html',
            strategy: 'preserve',
            transport: { safeTextBudget: 200 },
        });

        assert.ok(result.chunks.length >= 2, `expected split heading, got ${result.chunks.length} chunks`);
        assert.equal(result.diagnostics.usedStrategy, 'plain-text');
        assert.equal(result.diagnostics.usedMode, 'plain-text');
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 200, `chunk too long: ${chunk.content.length}`);
        }
    });

    it('code_block can be split in plain-text', () => {
        const code = '```\n' + 'line\n'.repeat(80) + '```';
        const result = plan(code, {
            strategy: 'plain-text',
            transport: { safeTextBudget: 250 },
        });
        assert.ok(result.chunks.length >= 2);
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 250);
            assert.equal(chunk.mode, 'plain-text');
        }
    });
});

// =============== forced-plain-text ===============

describe('planner — forced-plain-text', () => {
    it('splits very long text without spaces', () => {
        const md = 'x'.repeat(1000);
        const result = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(result.chunks.length >= 5);
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 200);
        }
    });

    it('prefers \\n\\n over \\n over whitespace', () => {
        // First block > needs to fit in budget, second part tests boundary
        const md = 'A'.repeat(100) + '\n\n' + 'B'.repeat(100) + '\nthird line word';
        const result = plan(md, { transport: { safeTextBudget: 200 } });
        // First chunk should split at \n\n (A block = 100 chars)
        assert.ok(result.chunks[0].content.includes('A'.repeat(100)));
        assert.ok(!result.chunks[0].content.includes('B'));
    });

    it('handles surrogate pairs correctly', () => {
        const emoji = '\uD83D\uDE00'; // 😀
        const md = emoji.repeat(150); // 300 code units
        const result = plan(md, { transport: { safeTextBudget: 200 } });
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 200);
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
        const code = '```js\n' + 'x = 1;\n'.repeat(60) + '```';
        const result = plan(code, {
            strategy: 'forced-plain-text',
            transport: { safeTextBudget: 200 },
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
        const md = 'A'.repeat(150) + '\n\n' + 'B'.repeat(150) + '\n\n' + 'C'.repeat(150);
        const result = plan(md, { transport: { safeTextBudget: 200 } });
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
    it('empty IR keeps zero diagnostics but still resolves mode fallback', () => {
        const result = plan('   \n\n   ', {
            preferredMode: 'rich-html',
            transport: { supportsRichHtml: false },
        });
        const d = result.diagnostics;

        assert.deepEqual(result.chunks, []);
        assert.equal(d.sourceLength, 8);
        assert.equal(d.plainTextLengthEstimate, 0);
        assert.equal(d.normalizedBlockCount, 0);
        assert.equal(d.chunkCount, 0);
        assert.equal(d.requestedStrategy, 'preserve');
        assert.equal(d.usedStrategy, 'preserve');
        assert.equal(d.requestedMode, 'rich-html');
        assert.equal(d.usedMode, 'plain-text');
        assert.equal(d.degradedToPlainText, true);
        assert.equal(d.hadDegradation, true);
        assert.deepEqual(d.splitBlockTypes, []);
    });

    it('empty IR with rich-html transport does not report degradation', () => {
        const result = plan('', {
            preferredMode: 'auto',
            transport: { supportsRichHtml: true },
        });
        const d = result.diagnostics;

        assert.equal(d.sourceLength, 0);
        assert.equal(d.plainTextLengthEstimate, 0);
        assert.equal(d.normalizedBlockCount, 0);
        assert.equal(d.chunkCount, 0);
        assert.equal(d.usedMode, 'rich-html');
        assert.equal(d.degradedToPlainText, false);
        assert.equal(d.hadDegradation, false);
    });

    it('forced-plain-text requested from rich preference reports mode degradation explicitly', () => {
        const result = plan('A'.repeat(450), {
            preferredMode: 'rich-html',
            strategy: 'forced-plain-text',
            transport: { safeTextBudget: 200 },
        });
        const d = result.diagnostics;

        assert.ok(result.chunks.length >= 3);
        assert.equal(d.requestedStrategy, 'forced-plain-text');
        assert.equal(d.usedStrategy, 'forced-plain-text');
        assert.equal(d.requestedMode, 'rich-html');
        assert.equal(d.usedMode, 'plain-text');
        assert.equal(d.degradedToPlainText, true);
        assert.equal(d.hadDegradation, true);
        assert.deepEqual(d.splitBlockTypes, ['paragraph']);
    });

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
        const md = 'A'.repeat(500);
        const result = plan(md, { transport: { safeTextBudget: 200 } });
        assert.ok(result.diagnostics.hadDegradation);
    });

    it('reports degradedToPlainText', () => {
        // Giant code block is atomic in rich-html → forces plain-text degradation
        const md = '```\n' + 'x'.repeat(300) + '\n```';
        const result = plan(md, {
            preferredMode: 'rich-html',
            transport: { safeTextBudget: 250 },
        });
        assert.equal(result.diagnostics.degradedToPlainText, true);
    });

    it('reports splitBlockTypes', () => {
        const sentence = 'Word. ';
        const md = sentence.repeat(100); // long paragraph
        const result = plan(md, { transport: { safeTextBudget: 250 } });
        if (result.diagnostics.usedStrategy === 'split-blocks-soft' ||
            result.diagnostics.usedStrategy === 'plain-text') {
            assert.ok(result.diagnostics.splitBlockTypes.includes('paragraph'));
        }
    });

    it('reports degradation for unsupported raw HTML lowered to text', () => {
        const result = plan('<b>x</b>', {
            preferredMode: 'rich-html',
            strategy: 'preserve',
            transport: { safeTextBudget: 500 },
        });

        assert.equal(result.chunks.length, 1);
        assert.equal(result.chunks[0].content, '&lt;b&gt;x&lt;/b&gt;');
        assert.equal(
            result.diagnostics.hadDegradation,
            true,
            'raw HTML is lowered to literal text and must be reported as degradation'
        );
    });

    it('reports degradation for unsupported table lowered to plain text', () => {
        const md = '| A | B |\n| - | - |\n| 1 | 2 |';
        const result = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'preserve',
            transport: { safeTextBudget: 500 },
        });

        assert.equal(result.chunks.length, 1);
        assert.equal(result.chunks[0].content, md);
        assert.equal(
            result.diagnostics.hadDegradation,
            true,
            'unsupported table syntax is lowered to text and must be reported as degradation'
        );
    });
});

// =============== budget invariant ===============

describe('planner — budget invariant', () => {
    it('no chunk exceeds safeTextBudget', () => {
        const cases = [
            'Simple text',
            '**Bold** and *italic* and `code`',
            'A'.repeat(1000),
            'Word. '.repeat(200),
            '# Title\n\n' + 'Para. '.repeat(50) + '\n\n- item1\n- item2\n\n> quote\n\n```\ncode\n```',
        ];
        for (const md of cases) {
            const result = plan(md, { transport: { safeTextBudget: 200 } });
            for (const chunk of result.chunks) {
                assert.ok(
                    chunk.content.length <= 200,
                    `Budget exceeded: ${chunk.content.length} > 200 for strategy ${result.diagnostics.usedStrategy}: "${chunk.content.slice(0, 50)}..."`
                );
            }
        }
    });

    it('never returns an oversized continuation chunk for split list items', () => {
        const md = '- short\n\n  ' + 'word '.repeat(80);
        const budget = 200;
        const result = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: budget },
        });

        assert.ok(result.chunks.length >= 2, `expected split plan, got ${result.chunks.length} chunks`);
        for (const chunk of result.chunks) {
            assert.ok(
                chunk.content.length <= budget,
                `Budget exceeded for list-item continuation: ${chunk.content.length} > ${budget}; ` +
                `content=${JSON.stringify(chunk.content)}`
            );
        }
    });

    it('keeps continuation chunks within budget after splitting the first list-item block', () => {
        const md = '- ' + 'intro '.repeat(80) + '\n\n  ' + 'tail '.repeat(80);
        const budget = 200;
        const result = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: budget },
        });

        assert.ok(result.chunks.length >= 3, `expected split plan, got ${result.chunks.length} chunks`);
        for (const chunk of result.chunks) {
            assert.ok(
                chunk.content.length <= budget,
                `Budget exceeded after first-block split: ${chunk.content.length} > ${budget}; ` +
                `content=${JSON.stringify(chunk.content)}`
            );
        }
    });
});

// =============== validation ===============

describe('planner — final chunk validation helper', () => {
    it('accepts chunks within safeTextBudget', () => {
        assert.doesNotThrow(() => {
            assertChunksWithinBudget([
                { index: 0, content: 'short' },
                { index: 1, content: 'still fine' },
            ], 20);
        });
    });

    it('throws when a final chunk exceeds safeTextBudget', () => {
        assert.throws(
            () => assertChunksWithinBudget([
                { index: 0, content: 'ok' },
                { index: 1, content: 'x'.repeat(21) },
            ], 20),
            /chunk 1 exceeds safeTextBudget \(21 > 20\)/
        );
    });
});

describe('planner — validation', () => {
    it('throws on unknown strategy', () => {
        assert.throws(
            () => planDelivery({
                markdown: 'Hello',
                preferredMode: 'plain-text',
                strategy: 'unknown-strategy',
                transport,
            }),
            /Unknown strategy/
        );
    });

    it('throws on unknown preferredMode', () => {
        assert.throws(
            () => planDelivery({
                markdown: 'Hello',
                preferredMode: 'weird-mode',
                strategy: 'preserve',
                transport,
            }),
            /Unknown preferredMode/
        );
    });
});

// =============== determinism ===============

describe('planner — determinism', () => {
    it('same input produces same plan', () => {
        const md = '# Title\n\nParagraph with **bold**.\n\n- item 1\n- item 2';
        const r1 = plan(md, { transport: { safeTextBudget: 200 } });
        const r2 = plan(md, { transport: { safeTextBudget: 200 } });
        assert.equal(r1.chunks.length, r2.chunks.length);
        for (let i = 0; i < r1.chunks.length; i++) {
            assert.equal(r1.chunks[i].content, r2.chunks[i].content);
            assert.equal(r1.chunks[i].mode, r2.chunks[i].mode);
        }
    });
});

describe('planner — list_item continuation semantics', () => {
    it('repeats bullet marker in continuation fragments when paragraph split allows it', () => {
        const md = '- ' + 'alpha beta gamma delta. '.repeat(20);
        const result = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
        });

        assert.ok(result.chunks.length >= 2, `expected split list item, got ${result.chunks.length} chunk(s)`);
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.startsWith('- '), `expected repeated marker, got ${JSON.stringify(chunk.content)}`);
            assert.ok(chunk.content.length <= 200, `chunk ${chunk.index} too long: ${chunk.content.length}`);
        }
    });

    it('keeps multi-paragraph continuation readable after split', () => {
        const md = '- first para ' + 'one two three four. '.repeat(8) + '\n\n  second para ' + 'five six seven eight. '.repeat(8);
        const result = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'split-blocks-soft',
            transport: { safeTextBudget: 200 },
        });

        assert.equal(result.diagnostics.usedStrategy, 'split-blocks-soft');
        assert.ok(result.chunks.length >= 2, `expected split list item, got ${result.chunks.length} chunk(s)`);
        assert.match(result.chunks[0].content, /^- first para /);
        assert.ok(result.chunks.some(chunk => /^- second para /.test(chunk.content)), 'expected readable continuation for second paragraph');
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 200, `chunk ${chunk.index} too long: ${chunk.content.length}`);
        }
    });

    it('forced-plain-text may degrade continuation to plain text without repeated marker', () => {
        const md = '- ' + 'Supercalifragilisticexpialidocious'.repeat(15);
        const result = plan(md, {
            preferredMode: 'plain-text',
            strategy: 'forced-plain-text',
            transport: { safeTextBudget: 200 },
        });

        assert.equal(result.diagnostics.usedStrategy, 'forced-plain-text');
        assert.ok(result.chunks.length >= 3, `expected degraded continuation, got ${result.chunks.length} chunk(s)`);
        assert.match(result.chunks[0].content, /^-\s?$/);
        assert.ok(result.chunks.slice(1).some(chunk => !chunk.content.startsWith('- ')), 'expected degraded continuation without repeated marker');
        for (const chunk of result.chunks) {
            assert.ok(chunk.content.length <= 200, `chunk ${chunk.index} too long: ${chunk.content.length}`);
        }
    });
});

describe('planner — splitBlockTypes semantics', () => {
    it('keeps splitBlockTypes unique when the same block type is split multiple times', () => {
        const md = 'Word. '.repeat(100);
        const result = plan(md, {
            preferredMode: 'auto',
            strategy: 'preserve',
            transport: { safeTextBudget: 200 },
        });

        assert.deepEqual(
            result.diagnostics.splitBlockTypes,
            ['paragraph'],
            `expected unique splitBlockTypes, got ${JSON.stringify(result.diagnostics.splitBlockTypes)}`
        );
    });

    it('reports splitBlockTypes in order of first actual split', () => {
        const md = '> ' + 'quoted text. '.repeat(30) + '\n\n' + 'tail '.repeat(120);
        const result = plan(md, {
            preferredMode: 'auto',
            strategy: 'preserve',
            transport: { safeTextBudget: 200 },
        });

        assert.deepEqual(
            result.diagnostics.splitBlockTypes,
            ['quote', 'paragraph'],
            `expected split order ["quote", "paragraph"], got ${JSON.stringify(result.diagnostics.splitBlockTypes)}`
        );
    });

    it('does not add degraded-only unsupported constructs to splitBlockTypes', () => {
        const rawHtml = plan('<b>x</b>', {
            preferredMode: 'rich-html',
            strategy: 'preserve',
            transport: { safeTextBudget: 500 },
        });
        const table = plan('| A | B |\n| - | - |\n| 1 | 2 |', {
            preferredMode: 'plain-text',
            strategy: 'preserve',
            transport: { safeTextBudget: 500 },
        });

        assert.deepEqual(rawHtml.diagnostics.splitBlockTypes, []);
        assert.deepEqual(table.diagnostics.splitBlockTypes, []);
    });
});
