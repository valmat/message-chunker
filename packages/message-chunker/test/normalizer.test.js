import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalize, _normalizeFromTokens } from '../src/normalizer.js';

// Helper: get types of top-level children
function topTypes(ir) {
    return ir.children.map(n => n.type);
}

// Helper: collect all text content from IR subtree
function collectText(node) {
    if (node.value !== undefined) return node.value;
    if (node.children) return node.children.map(collectText).join('');
    return '';
}

function childTypes(node) {
    return (node.children || []).map(child => child.type);
}

describe('normalizer — paragraphs', () => {
    it('single paragraph', () => {
        const ir = normalize('Hello world');
        assert.deepEqual(topTypes(ir), ['paragraph']);
        assert.equal(collectText(ir.children[0]), 'Hello world');
    });

    it('multiple paragraphs', () => {
        const ir = normalize('First\n\nSecond\n\nThird');
        assert.deepEqual(topTypes(ir), ['paragraph', 'paragraph', 'paragraph']);
        assert.equal(collectText(ir.children[0]), 'First');
        assert.equal(collectText(ir.children[2]), 'Third');
    });

    it('empty input returns empty root', () => {
        const ir = normalize('');
        assert.equal(ir.type, 'root');
        assert.equal(ir.children.length, 0);
    });

    it('whitespace-only input returns empty root', () => {
        const ir = normalize('   \n  \n   ');
        assert.equal(ir.children.length, 0);
    });

    it('single newline inside paragraph becomes soft_break', () => {
        const ir = normalize('alpha\nbeta');
        const paragraph = ir.children[0];

        assert.equal(paragraph.type, 'paragraph');
        assert.deepEqual(childTypes(paragraph), ['text', 'soft_break', 'text']);
        assert.equal(paragraph.children[0].value, 'alpha');
        assert.equal(paragraph.children[2].value, 'beta');
    });

    it('markdown hard break becomes hard_break', () => {
        const ir = normalize('alpha  \nbeta');
        const paragraph = ir.children[0];

        assert.equal(paragraph.type, 'paragraph');
        assert.deepEqual(childTypes(paragraph), ['text', 'hard_break', 'text']);
        assert.equal(paragraph.children[0].value, 'alpha');
        assert.equal(paragraph.children[2].value, 'beta');
    });
});

describe('normalizer — headings', () => {
    it('h1..h6 levels', () => {
        const ir = normalize('# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6');
        const headings = ir.children.filter(n => n.type === 'heading');
        assert.equal(headings.length, 6);
        assert.deepEqual(headings.map(h => h.level), [1, 2, 3, 4, 5, 6]);
        assert.equal(collectText(headings[0]), 'H1');
    });

    it('heading with inline formatting', () => {
        const ir = normalize('## **Bold** heading');
        const h = ir.children[0];
        assert.equal(h.type, 'heading');
        assert.equal(h.level, 2);
        assert.equal(h.children[0].type, 'strong');
        assert.equal(collectText(h.children[0]), 'Bold');
    });
});

describe('normalizer — lists', () => {
    it('bullet list', () => {
        const ir = normalize('- one\n- two\n- three');
        assert.equal(ir.children.length, 1);
        const list = ir.children[0];
        assert.equal(list.type, 'list');
        assert.equal(list.ordered, false);
        assert.equal(list.children.length, 3);
        assert.equal(list.children[0].type, 'list_item');
        assert.equal(list.children[0].marker, '-');
        assert.equal(collectText(list.children[0]), 'one');
    });

    it('ordered list', () => {
        const ir = normalize('1. first\n2. second\n3. third');
        const list = ir.children[0];
        assert.equal(list.type, 'list');
        assert.equal(list.ordered, true);
        assert.equal(list.start, 1);
        assert.equal(list.children.length, 3);
        assert.equal(list.children[0].marker, '1.');
        assert.equal(list.children[1].marker, '2.');
        assert.equal(list.children[2].marker, '3.');
    });

    it('ordered list starting at 3', () => {
        const ir = normalize('3. three\n4. four');
        const list = ir.children[0];
        assert.equal(list.start, 3);
        assert.equal(list.children[0].marker, '3.');
        assert.equal(list.children[1].marker, '4.');
    });

    it('nested list', () => {
        const ir = normalize('- outer\n  - inner1\n  - inner2\n- another');
        const list = ir.children[0];
        assert.equal(list.children.length, 2);
        // First item has a paragraph + nested list
        const firstItem = list.children[0];
        const nestedList = firstItem.children.find(n => n.type === 'list');
        assert.ok(nestedList, 'should have nested list');
        assert.equal(nestedList.children.length, 2);
        assert.equal(collectText(nestedList.children[0]), 'inner1');
    });

    it('list item with multiple paragraphs', () => {
        const ir = normalize('- first para\n\n  second para\n\n- next item');
        const list = ir.children[0];
        const firstItem = list.children[0];
        const paragraphs = firstItem.children.filter(n => n.type === 'paragraph');
        assert.ok(paragraphs.length >= 2, 'should have at least 2 paragraphs in list item');
    });
});

describe('normalizer — quotes', () => {
    it('simple quote', () => {
        const ir = normalize('> quoted text');
        assert.equal(ir.children.length, 1);
        const q = ir.children[0];
        assert.equal(q.type, 'quote');
        assert.equal(q.children[0].type, 'paragraph');
        assert.equal(collectText(q.children[0]), 'quoted text');
    });

    it('quote with multiple paragraphs', () => {
        const ir = normalize('> first\n>\n> second');
        const q = ir.children[0];
        assert.equal(q.children.length, 2);
        assert.equal(collectText(q.children[0]), 'first');
        assert.equal(collectText(q.children[1]), 'second');
    });

    it('nested quote', () => {
        const ir = normalize('> outer\n>> inner');
        const q = ir.children[0];
        const inner = q.children.find(n => n.type === 'quote');
        assert.ok(inner, 'should have nested quote');
    });
});

describe('normalizer — code blocks', () => {
    it('fenced code block without language', () => {
        const ir = normalize('```\nconsole.log("hi");\n```');
        assert.equal(ir.children.length, 1);
        const cb = ir.children[0];
        assert.equal(cb.type, 'code_block');
        assert.equal(cb.value, 'console.log("hi");');
        assert.equal(cb.lang, '');
    });

    it('fenced code block with language', () => {
        const ir = normalize('```js\nconst x = 1;\n```');
        const cb = ir.children[0];
        assert.equal(cb.type, 'code_block');
        assert.equal(cb.lang, 'js');
        assert.equal(cb.value, 'const x = 1;');
    });

    it('indented code block', () => {
        const ir = normalize('    code line 1\n    code line 2');
        const cb = ir.children[0];
        assert.equal(cb.type, 'code_block');
        assert.ok(cb.value.includes('code line 1'));
        assert.ok(cb.value.includes('code line 2'));
    });

    it('multi-line fenced code block preserves inner newlines', () => {
        const ir = normalize('```\nline1\nline2\nline3\n```');
        const cb = ir.children[0];
        assert.equal(cb.value, 'line1\nline2\nline3');
    });
});

describe('normalizer — thematic break', () => {
    it('horizontal rule', () => {
        const ir = normalize('---');
        assert.equal(ir.children.length, 1);
        assert.equal(ir.children[0].type, 'thematic_break');
    });

    it('hr between paragraphs', () => {
        const ir = normalize('above\n\n---\n\nbelow');
        assert.deepEqual(topTypes(ir), ['paragraph', 'thematic_break', 'paragraph']);
    });
});

describe('normalizer — inline formatting', () => {
    it('bold with **', () => {
        const ir = normalize('**bold**');
        const p = ir.children[0];
        assert.equal(p.children.length, 1);
        assert.equal(p.children[0].type, 'strong');
        assert.equal(collectText(p.children[0]), 'bold');
    });

    it('italic with *', () => {
        const ir = normalize('*italic*');
        const p = ir.children[0];
        assert.equal(p.children.length, 1);
        assert.equal(p.children[0].type, 'emphasis');
        assert.equal(collectText(p.children[0]), 'italic');
    });

    it('inline code', () => {
        const ir = normalize('use `code` here');
        const p = ir.children[0];
        const code = p.children.find(n => n.type === 'inline_code');
        assert.ok(code);
        assert.equal(code.value, 'code');
    });

    it('link with label', () => {
        const ir = normalize('[Google](https://google.com)');
        const p = ir.children[0];
        assert.equal(p.children[0].type, 'link');
        assert.equal(p.children[0].href, 'https://google.com');
        assert.equal(collectText(p.children[0]), 'Google');
    });

    it('nested bold inside italic', () => {
        const ir = normalize('*text **bold** more*');
        const p = ir.children[0];
        const em = p.children[0];
        assert.equal(em.type, 'emphasis');
        const strong = em.children.find(n => n.type === 'strong');
        assert.ok(strong);
        assert.equal(collectText(strong), 'bold');
    });

    it('mixed inline', () => {
        const ir = normalize('Hello **bold** and *italic* and `code`');
        const p = ir.children[0];
        const types = p.children.map(n => n.type);
        assert.ok(types.includes('strong'));
        assert.ok(types.includes('emphasis'));
        assert.ok(types.includes('inline_code'));
    });
});

describe('normalizer — underscore emphasis NOT supported', () => {
    it('_text_ stays literal', () => {
        const ir = normalize('_not italic_');
        const p = ir.children[0];
        const text = collectText(p);
        assert.ok(text.includes('_not italic_'), `expected underscores preserved, got: "${text}"`);
        const hasEmphasis = p.children.some(n => n.type === 'emphasis');
        assert.equal(hasEmphasis, false, 'should not have emphasis node');
    });

    it('__text__ stays literal', () => {
        const ir = normalize('__not bold__');
        const p = ir.children[0];
        const text = collectText(p);
        assert.ok(text.includes('__not bold__'), `expected underscores preserved, got: "${text}"`);
        const hasStrong = p.children.some(n => n.type === 'strong');
        assert.equal(hasStrong, false, 'should not have strong node');
    });

    it('mixed: *asterisk* works but _underscore_ does not', () => {
        const ir = normalize('*yes* and _no_');
        const p = ir.children[0];
        const em = p.children.find(n => n.type === 'emphasis');
        assert.ok(em, 'asterisk emphasis should work');
        assert.equal(collectText(em), 'yes');
        const fullText = collectText(p);
        assert.ok(fullText.includes('_no_'), 'underscore should stay literal');
    });

    it('underscore in variable names stays as is', () => {
        const ir = normalize('use my_variable_name in code');
        const text = collectText(ir.children[0]);
        assert.ok(text.includes('my_variable_name'));
    });
});

describe('normalizer — raw HTML', () => {
    it('html block becomes text paragraph', () => {
        const ir = normalize('<div>hello</div>');
        assert.equal(ir.children.length, 1);
        const p = ir.children[0];
        assert.equal(p.type, 'paragraph');
        assert.ok(collectText(p).includes('<div>hello</div>'));
    });

    it('inline html becomes text', () => {
        const ir = normalize('before <br> after');
        const p = ir.children[0];
        const text = collectText(p);
        assert.ok(text.includes('<br>'), `should contain <br>, got: "${text}"`);
    });
});

describe('normalizer — tables (unsupported)', () => {
    it('table becomes text paragraphs with pipes', () => {
        const ir = normalize('| A | B |\n|---|---|\n| 1 | 2 |');
        // With table rule disabled, pipe text falls through as paragraphs
        const text = ir.children.map(n => collectText(n)).join('\n');
        assert.ok(text.includes('A'), 'should preserve table text');
        assert.ok(text.includes('B'), 'should preserve table text');
        // Should NOT produce table IR nodes
        const types = topTypes(ir);
        assert.ok(!types.includes('table'), 'should not have table nodes');
    });
});

describe('normalizer — images', () => {
    it('image becomes text with alt and src', () => {
        const ir = normalize('![Alt text](http://example.com/img.png)');
        const text = collectText(ir.children[0]);
        assert.ok(text.includes('Alt text'));
        assert.ok(text.includes('http://example.com/img.png'));
    });
});

describe('normalizer — complex document', () => {
    it('mixed blocks produce correct IR structure', () => {
        const md = [
            '# Title',
            '',
            'A paragraph with **bold** and *italic*.',
            '',
            '- item 1',
            '- item 2',
            '',
            '> a quote',
            '',
            '```js',
            'code();',
            '```',
            '',
            '---',
            '',
            'Final para.',
        ].join('\n');

        const ir = normalize(md);
        assert.deepEqual(topTypes(ir), [
            'heading',
            'paragraph',
            'list',
            'quote',
            'code_block',
            'thematic_break',
            'paragraph',
        ]);
    });

    it('IR is deterministic', () => {
        const md = '**bold** and *italic* and `code` and [link](url)';
        const ir1 = normalize(md);
        const ir2 = normalize(md);
        assert.deepEqual(ir1, ir2);
    });
});

describe('normalizer — unsupported markdown fallbacks', () => {
    it('footnote-like syntax stays as plain text in document order', () => {
        const md = 'note[^1]\n\n[^1]: footnote text';
        const ir = normalize(md);

        assert.deepEqual(topTypes(ir), ['paragraph', 'paragraph']);
        assert.equal(collectText(ir.children[0]), 'note[^1]');
        assert.equal(collectText(ir.children[1]), '[^1]: footnote text');
    });

    it('directive-like syntax stays as literal text', () => {
        const md = '::note\ncontent\n::';
        const ir = normalize(md);
        const paragraph = ir.children[0];

        assert.equal(paragraph.type, 'paragraph');
        assert.deepEqual(childTypes(paragraph), ['text', 'soft_break', 'text', 'soft_break', 'text']);
        assert.equal(collectText(paragraph), '::notecontent::');
        assert.equal(paragraph.children[0].value, '::note');
        assert.equal(paragraph.children[2].value, 'content');
        assert.equal(paragraph.children[4].value, '::');
    });
});

describe('normalizer — synthetic fallback coverage', () => {
    it('uses attrs fallback and survives missing list close tokens', () => {
        const ir = _normalizeFromTokens([
            { type: 'ordered_list_open', attrs: [['start', '3']] },
            { type: 'list_item_open', markup: '.' },
            { type: 'paragraph_open' },
            { type: 'inline', children: [{ type: 'text', content: 'third item' }] },
            { type: 'paragraph_close' },
            { type: 'list_item_close' },
            { type: 'dummy_tail' },
        ], 'ignored');
        const list = ir.children[0];

        assert.equal(list.type, 'list');
        assert.equal(list.ordered, true);
        assert.equal(list.start, 3);
        assert.equal(list.children[0].marker, '3.');
        assert.equal(collectText(list.children[0]), 'third item');
    });

    it('skips orphan block close tokens and converts block-level inline/unknown block to paragraphs', () => {
        const ir = _normalizeFromTokens([
            { type: 'paragraph_close' },
            { type: 'inline', children: [{ type: 'text', content: 'loose inline' }] },
            { type: 'mystery_block', content: 'fallback block' },
        ], 'ignored');

        assert.deepEqual(topTypes(ir), ['paragraph', 'paragraph']);
        assert.equal(collectText(ir.children[0]), 'loose inline');
        assert.equal(collectText(ir.children[1]), 'fallback block');
    });

    it('drops a single empty text leaf produced by inline fallback', () => {
        const ir = _normalizeFromTokens([
            { type: 'paragraph_open' },
            { type: 'inline', children: [{ type: 'text', content: '' }] },
            { type: 'paragraph_close' },
        ], 'ignored');
        const paragraph = ir.children[0];

        assert.equal(paragraph.type, 'paragraph');
        assert.deepEqual(paragraph.children, []);
    });

    it('merges adjacent inline fallback text nodes and skips orphan inline closes', () => {
        const ir = _normalizeFromTokens([
            {
                type: 'paragraph_open',
            },
            {
                type: 'inline',
                children: [
                    { type: 'html_inline', content: '<raw>' },
                    { type: 'mystery_inline', content: '??' },
                    { type: 'text', content: 'tail' },
                    { type: 'em_close' },
                    { type: 'text', content: '' },
                ],
            },
            { type: 'paragraph_close' },
        ], 'ignored');
        const paragraph = ir.children[0];

        assert.deepEqual(childTypes(paragraph), ['text']);
        assert.equal(paragraph.children[0].value, '<raw>??tail');
    });
});

