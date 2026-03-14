// Markdown parser: markdown string → markdown-it token stream
// nodejs: v18.16.0
// tab=4spaces

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: false });

/**
 * Parse markdown string into markdown-it token array.
 * @param {string} markdown
 * @returns {import('markdown-it/lib/token')[]}
 */
export function parse(markdown) {
    return md.parse(markdown, {});
}
