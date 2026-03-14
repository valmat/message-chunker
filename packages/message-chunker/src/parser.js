// Markdown parser: markdown string → markdown-it token stream
// nodejs: v18.16.0
// tab=4spaces

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: true, linkify: false });

// Tables are not supported in v1 IR — disable the rule so
// markdown-it leaves pipe-delimited text as plain paragraphs.
md.disable('table');

/**
 * Parse markdown string into markdown-it token array.
 * @param {string} markdown
 * @returns {import('markdown-it/lib/token')[]}
 */
export function parse(markdown) {
    return md.parse(markdown, {});
}
