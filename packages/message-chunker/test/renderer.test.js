import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalize } from '../src/normalizer.js';
import { renderHtml } from '../src/renderer-html.js';
import { renderPlain } from '../src/renderer-plain.js';

// Helper: normalize markdown and render with both renderers
function renderBoth(md) {
    const ir = normalize(md);
    return {
        html: renderHtml(ir.children),
        plain: renderPlain(ir.children),
    };
}

// =============== rich-html renderer ===============

describe('renderer-html — paragraphs', () => {
    it('simple paragraph escapes HTML', () => {
        const { html } = renderBoth('Hello <world> & "friends"');
        assert.equal(html, 'Hello &lt;world&gt; &amp; &quot;friends&quot;');
    });

    it('multiple paragraphs separated by \\n\\n', () => {
        const { html } = renderBoth('First\n\nSecond');
        assert.equal(html, 'First\n\nSecond');
    });
});

describe('renderer-html — headings', () => {
    it('heading rendered as <b>text</b>', () => {
        const { html } = renderBoth('# Title');
        assert.equal(html, '<b>Title</b>');
    });

    it('heading with inline formatting', () => {
        const { html } = renderBoth('## **Bold** title');
        assert.equal(html, '<b><b>Bold</b> title</b>');
    });
});

describe('renderer-html — inline formatting', () => {
    it('strong', () => {
        const { html } = renderBoth('**bold**');
        assert.equal(html, '<b>bold</b>');
    });

    it('emphasis', () => {
        const { html } = renderBoth('*italic*');
        assert.equal(html, '<i>italic</i>');
    });

    it('inline code', () => {
        const { html } = renderBoth('use `<div>` here');
        assert.equal(html, 'use <code>&lt;div&gt;</code> here');
    });

    it('nested strong + emphasis', () => {
        const { html } = renderBoth('***bold italic***');
        // markdown-it may nest these as em > strong or strong > em
        assert.ok(html.includes('<b>') && html.includes('<i>'));
        assert.ok(html.includes('bold italic'));
    });
});

describe('renderer-html — links', () => {
    it('link with label different from URL', () => {
        const { html } = renderBoth('[Google](https://google.com)');
        assert.equal(html, '<a href="https://google.com">Google</a>');
    });

    it('link where label equals URL', () => {
        const { html } = renderBoth('[https://example.com](https://example.com)');
        assert.equal(html, '<a href="https://example.com">https://example.com</a>');
    });

    it('link with formatted label', () => {
        const { html } = renderBoth('[**Bold** link](https://example.com)');
        assert.equal(html, '<a href="https://example.com"><b>Bold</b> link</a>');
    });

    it('link href is escaped', () => {
        const { html } = renderBoth('[test](https://example.com?a=1&b=2)');
        assert.ok(html.includes('href="https://example.com?a=1&amp;b=2"'));
    });
});

describe('renderer-html — lists', () => {
    it('bullet list items separated by \\n', () => {
        const { html } = renderBoth('- one\n- two\n- three');
        assert.equal(html, '- one\n- two\n- three');
    });

    it('ordered list with markers', () => {
        const { html } = renderBoth('1. first\n2. second');
        assert.equal(html, '1. first\n2. second');
    });

    it('list item with multiple paragraphs', () => {
        const { html } = renderBoth('- para one\n\n  para two\n\n- next');
        // First item: "- para one\n  para two"
        // Second item: "- next"
        assert.ok(html.includes('- para one'));
        assert.ok(html.includes('  para two'));
        assert.ok(html.includes('- next'));
    });

    it('nested list', () => {
        const { html } = renderBoth('- outer\n  - inner1\n  - inner2');
        assert.ok(html.includes('- outer'));
        assert.ok(html.includes('inner1'));
        assert.ok(html.includes('inner2'));
    });
});

describe('renderer-html — quotes', () => {
    it('simple quote', () => {
        const { html } = renderBoth('> hello');
        assert.equal(html, '&gt; hello');
    });

    it('quote with multiple paragraphs', () => {
        const { html } = renderBoth('> first\n>\n> second');
        assert.equal(html, '&gt; first\n&gt;\n&gt; second');
    });

    it('raw HTML inside quote is escaped', () => {
        const { html } = renderBoth('> text with <b>tag</b>');
        assert.ok(html.includes('&gt; text with &lt;b&gt;tag&lt;/b&gt;'));
    });
});

describe('renderer-html — code blocks', () => {
    it('code block without language', () => {
        const { html } = renderBoth('```\ncode\n```');
        assert.equal(html, '<pre>code</pre>');
    });

    it('code block with language preserves language info', () => {
        const { html } = renderBoth('```js\nconst x = 1;\n```');
        assert.equal(html, '<pre><code class="language-js">const x = 1;</code></pre>');
    });

    it('code block with language escapes language string', () => {
        const { html } = renderBoth('```c++\nint x;\n```');
        assert.ok(html.includes('class="language-c++">'));
    });

    it('code block escapes HTML', () => {
        const { html } = renderBoth('```\n<div>&</div>\n```');
        assert.equal(html, '<pre>&lt;div&gt;&amp;&lt;/div&gt;</pre>');
    });
});

describe('renderer-html — thematic break', () => {
    it('hr between paragraphs', () => {
        const { html } = renderBoth('above\n\n---\n\nbelow');
        assert.equal(html, 'above\n\n---\n\nbelow');
    });
});

describe('renderer-html — block spacing', () => {
    it('all block types have correct spacing', () => {
        const md = '# Title\n\nParagraph\n\n- item\n\n> quote\n\n```\ncode\n```\n\n---\n\nEnd';
        const { html } = renderBoth(md);
        const blocks = html.split('\n\n');
        assert.equal(blocks[0], '<b>Title</b>');
        assert.equal(blocks[1], 'Paragraph');
        assert.equal(blocks[2], '- item');
        assert.equal(blocks[3], '&gt; quote');
        assert.equal(blocks[4], '<pre>code</pre>'); // no lang → simple <pre>
        assert.equal(blocks[5], '---');
        assert.equal(blocks[6], 'End');
    });
});

// =============== plain-text renderer ===============

describe('renderer-plain — paragraphs', () => {
    it('simple paragraph (no escaping)', () => {
        const { plain } = renderBoth('Hello <world> & "friends"');
        assert.equal(plain, 'Hello <world> & "friends"');
    });

    it('multiple paragraphs separated by \\n\\n', () => {
        const { plain } = renderBoth('First\n\nSecond');
        assert.equal(plain, 'First\n\nSecond');
    });
});

describe('renderer-plain — headings', () => {
    it('heading as plain text (no markup)', () => {
        const { plain } = renderBoth('# Title');
        assert.equal(plain, 'Title');
    });
});

describe('renderer-plain — inline formatting', () => {
    it('strong stripped', () => {
        const { plain } = renderBoth('**bold**');
        assert.equal(plain, 'bold');
    });

    it('emphasis stripped', () => {
        const { plain } = renderBoth('*italic*');
        assert.equal(plain, 'italic');
    });

    it('inline code value kept', () => {
        const { plain } = renderBoth('use `code` here');
        assert.equal(plain, 'use code here');
    });
});

describe('renderer-plain — links', () => {
    it('link with label different from URL', () => {
        const { plain } = renderBoth('[Google](https://google.com)');
        assert.equal(plain, 'Google (https://google.com)');
    });

    it('link where label equals URL', () => {
        const { plain } = renderBoth('[https://example.com](https://example.com)');
        assert.equal(plain, 'https://example.com');
    });
});

describe('renderer-plain — lists', () => {
    it('bullet list', () => {
        const { plain } = renderBoth('- one\n- two');
        assert.equal(plain, '- one\n- two');
    });

    it('ordered list', () => {
        const { plain } = renderBoth('1. first\n2. second');
        assert.equal(plain, '1. first\n2. second');
    });
});

describe('renderer-plain — quotes', () => {
    it('simple quote with > prefix', () => {
        const { plain } = renderBoth('> hello');
        assert.equal(plain, '> hello');
    });

    it('quote with multiple paragraphs', () => {
        const { plain } = renderBoth('> first\n>\n> second');
        assert.equal(plain, '> first\n>\n> second');
    });
});

describe('renderer-plain — code blocks', () => {
    it('code block with fences', () => {
        const { plain } = renderBoth('```\ncode line\n```');
        assert.equal(plain, '```\ncode line\n```');
    });

    it('code block with language', () => {
        const { plain } = renderBoth('```js\nconst x = 1;\n```');
        assert.equal(plain, '```js\nconst x = 1;\n```');
    });

    it('multi-line code block', () => {
        const { plain } = renderBoth('```\nline1\nline2\n```');
        assert.equal(plain, '```\nline1\nline2\n```');
    });
});

describe('renderer-plain — thematic break', () => {
    it('rendered as ---', () => {
        const { plain } = renderBoth('---');
        assert.equal(plain, '---');
    });
});

describe('renderer-plain — block spacing', () => {
    it('all block types have correct spacing', () => {
        const md = '# Title\n\nParagraph\n\n- item\n\n> quote\n\n```\ncode\n```\n\n---\n\nEnd';
        const { plain } = renderBoth(md);
        const blocks = plain.split('\n\n');
        assert.equal(blocks[0], 'Title');
        assert.equal(blocks[1], 'Paragraph');
        assert.equal(blocks[2], '- item');
        assert.equal(blocks[3], '> quote');
        assert.equal(blocks[4], '```\ncode\n```');
        assert.equal(blocks[5], '---');
        assert.equal(blocks[6], 'End');
    });
});

// =============== raw HTML handling ===============

describe('renderers — raw HTML', () => {
    it('html block escaped in rich-html', () => {
        const { html } = renderBoth('<div>content</div>');
        assert.ok(html.includes('&lt;div&gt;'));
        assert.ok(!html.includes('<div>'));
    });

    it('html block stays literal in plain-text', () => {
        const { plain } = renderBoth('<div>content</div>');
        assert.ok(plain.includes('<div>content</div>'));
    });

    it('inline html escaped in rich-html', () => {
        const { html } = renderBoth('text <br> more');
        assert.ok(html.includes('&lt;br&gt;'));
    });

    it('inline html literal in plain-text', () => {
        const { plain } = renderBoth('text <br> more');
        assert.ok(plain.includes('<br>'));
    });
});

// =============== underscore emphasis ===============

describe('renderers — underscore stays literal', () => {
    it('_text_ in rich-html escaped as text', () => {
        const { html } = renderBoth('_word_');
        assert.ok(!html.includes('<i>'), 'no italic tag');
        assert.ok(!html.includes('<em>'), 'no em tag');
        assert.ok(html.includes('_word_'));
    });

    it('_text_ in plain-text stays as is', () => {
        const { plain } = renderBoth('_word_');
        assert.ok(plain.includes('_word_'));
    });
});

// =============== empty input ===============

describe('renderers — edge cases', () => {
    it('empty blocks return empty string', () => {
        assert.equal(renderHtml([]), '');
        assert.equal(renderPlain([]), '');
    });

    it('empty markdown', () => {
        const { html, plain } = renderBoth('');
        assert.equal(html, '');
        assert.equal(plain, '');
    });
});
