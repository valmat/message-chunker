// Normalizer: markdown-it tokens → normalized IR
// nodejs: v18.16.0
// tab=4spaces

import { parse } from './parser.js';

/**
 * Parse markdown and normalize into IR tree.
 * @param {string} markdown
 * @returns {import('./types.js').IRNode}
 */
export function normalize(markdown) {
    const tokens = parse(markdown);
    const children = normalizeBlocks(tokens, 0, tokens.length);
    return {
        type: 'root',
        children,
        meta: {
            hadUnsupportedDegradation: detectUnsupportedDegradation(markdown, tokens),
        },
    };
}

// --------------- block-level normalization ---------------

function detectUnsupportedDegradation(markdown, tokens) {
    return hasUnsupportedToken(tokens) || looksLikeUnsupportedTable(markdown);
}

function hasUnsupportedToken(tokens) {
    for (const token of tokens) {
        if (token.type === 'html_block' || token.type === 'html_inline' || token.type === 'image') {
            return true;
        }
        if (token.children && hasUnsupportedToken(token.children)) {
            return true;
        }
    }
    return false;
}

function looksLikeUnsupportedTable(markdown) {
    return /(?:^|\n)\|.+\|\n\|[\s:|-]+\|(?:\n\|.*\|)*/m.test(markdown);
}


/**
 * Find the matching close token for an open token.
 * @param {object[]} tokens
 * @param {number} openIndex
 * @returns {number}
 */
function findMatchingClose(tokens, openIndex, end = tokens.length) {
    const openType = tokens[openIndex].type;
    const closeType = openType.replace('_open', '_close');
    let depth = 1;
    for (let i = openIndex + 1; i < end; i++) {
        if (tokens[i].type === openType) depth++;
        else if (tokens[i].type === closeType) {
            depth--;
            if (depth === 0) return i;
        }
    }
    // No matching close found — return end-1 so the caller's
    // `closeIdx + 1` does not overshoot the boundary.
    return end - 1;
}

/**
 * Normalize a range of block-level tokens into IR nodes.
 * @param {object[]} tokens
 * @param {number} start
 * @param {number} end
 * @returns {import('./types.js').IRNode[]}
 */
function normalizeBlocks(tokens, start, end) {
    const nodes = [];
    let i = start;

    while (i < end) {
        const token = tokens[i];

        switch (token.type) {
            case 'paragraph_open': {
                const inlineToken = (i + 1 < end && tokens[i + 1].type === 'inline')
                    ? tokens[i + 1] : null;
                const children = normalizeInline(inlineToken ? inlineToken.children : null);
                nodes.push({ type: 'paragraph', children });
                // Advance past open + inline + close; if inline is missing, skip just the open
                i += inlineToken ? 3 : 1;
                break;
            }

            case 'heading_open': {
                const level = parseInt(token.tag.slice(1));
                const inlineToken = (i + 1 < end && tokens[i + 1].type === 'inline')
                    ? tokens[i + 1] : null;
                const children = normalizeInline(inlineToken ? inlineToken.children : null);
                nodes.push({ type: 'heading', level, children });
                i += inlineToken ? 3 : 1;
                break;
            }

            case 'bullet_list_open':
            case 'ordered_list_open': {
                const closeIdx = findMatchingClose(tokens, i, end);
                const ordered = token.type === 'ordered_list_open';
                const startNum = ordered
                    ? parseInt(getAttr(token, 'start') || '1')
                    : undefined;

                const items = [];
                let j = i + 1;
                let itemIdx = 0;

                while (j < closeIdx) {
                    if (tokens[j].type === 'list_item_open') {
                        const itemCloseIdx = findMatchingClose(tokens, j, closeIdx);
                        const innerBlocks = normalizeBlocks(tokens, j + 1, itemCloseIdx);
                        const marker = ordered
                            ? `${(startNum || 1) + itemIdx}.`
                            : (tokens[j].markup || '-');
                        items.push({ type: 'list_item', marker, children: innerBlocks });
                        itemIdx++;
                        j = itemCloseIdx + 1;
                    } else {
                        j++;
                    }
                }

                nodes.push({
                    type: 'list',
                    ordered: ordered,
                    start: ordered ? (startNum || 1) : undefined,
                    children: items,
                });
                i = closeIdx + 1;
                break;
            }

            case 'blockquote_open': {
                const closeIdx = findMatchingClose(tokens, i, end);
                const innerBlocks = normalizeBlocks(tokens, i + 1, closeIdx);
                nodes.push({ type: 'quote', children: innerBlocks });
                i = closeIdx + 1;
                break;
            }

            case 'fence': {
                let value = token.content;
                if (value.endsWith('\n')) value = value.slice(0, -1);
                nodes.push({
                    type: 'code_block',
                    value,
                    lang: (token.info || '').trim(),
                });
                i++;
                break;
            }

            case 'code_block': {
                let value = token.content;
                if (value.endsWith('\n')) value = value.slice(0, -1);
                nodes.push({
                    type: 'code_block',
                    value,
                    lang: '',
                });
                i++;
                break;
            }

            case 'hr': {
                nodes.push({ type: 'thematic_break' });
                i++;
                break;
            }

            case 'html_block': {
                let value = token.content;
                if (value.endsWith('\n')) value = value.slice(0, -1);
                nodes.push({
                    type: 'paragraph',
                    children: [{ type: 'text', value }],
                });
                i++;
                break;
            }

            default: {
                // Skip close tokens
                if (token.type.endsWith('_close')) {
                    i++;
                    break;
                }
                // Orphaned inline token at block level
                if (token.type === 'inline') {
                    const children = normalizeInline(token.children);
                    if (children.length > 0) {
                        nodes.push({ type: 'paragraph', children });
                    }
                    i++;
                    break;
                }
                // Unknown block → text paragraph
                if (token.content) {
                    nodes.push({
                        type: 'paragraph',
                        children: [{ type: 'text', value: token.content }],
                    });
                }
                i++;
                break;
            }
        }
    }

    return nodes;
}

// --------------- inline normalization ---------------

/**
 * Normalize inline tokens into IR inline nodes.
 * Underscore emphasis (_/__) is converted to literal text.
 * @param {object[] | null} rawTokens
 * @returns {import('./types.js').IRNode[]}
 */
function normalizeInline(rawTokens) {
    if (!rawTokens || rawTokens.length === 0) return [];
    const tokens = preprocessUnderscoreEmphasis(rawTokens);
    const { children } = buildInlineTree(tokens, 0, null);
    return mergeAdjacentText(children);
}

/**
 * Convert underscore emphasis/strong tokens into plain text tokens.
 * Asterisk-based emphasis is kept as-is.
 */
function preprocessUnderscoreEmphasis(tokens) {
    return tokens.map(token => {
        const isUnderscoreMarker =
            (token.type === 'em_open' || token.type === 'em_close' ||
             token.type === 'strong_open' || token.type === 'strong_close') &&
            token.markup && token.markup.includes('_');

        if (isUnderscoreMarker) {
            return { type: 'text', content: token.markup };
        }
        return token;
    });
}

/**
 * Build IR tree from a flat sequence of inline tokens.
 * Uses recursive descent: on _open tokens, recurse until matching _close.
 */
function buildInlineTree(tokens, start, stopType) {
    const children = [];
    let i = start;

    while (i < tokens.length) {
        const token = tokens[i];

        if (stopType && token.type === stopType) {
            return { children, nextIndex: i + 1 };
        }

        switch (token.type) {
            case 'text': {
                children.push({ type: 'text', value: token.content });
                i++;
                break;
            }

            case 'code_inline': {
                children.push({ type: 'inline_code', value: token.content });
                i++;
                break;
            }

            case 'softbreak': {
                children.push({ type: 'soft_break' });
                i++;
                break;
            }

            case 'hardbreak': {
                children.push({ type: 'hard_break' });
                i++;
                break;
            }

            case 'em_open': {
                const inner = buildInlineTree(tokens, i + 1, 'em_close');
                children.push({ type: 'emphasis', children: mergeAdjacentText(inner.children) });
                i = inner.nextIndex;
                break;
            }

            case 'strong_open': {
                const inner = buildInlineTree(tokens, i + 1, 'strong_close');
                children.push({ type: 'strong', children: mergeAdjacentText(inner.children) });
                i = inner.nextIndex;
                break;
            }

            case 'link_open': {
                const href = getAttr(token, 'href') || '';
                const inner = buildInlineTree(tokens, i + 1, 'link_close');
                children.push({ type: 'link', href, children: mergeAdjacentText(inner.children) });
                i = inner.nextIndex;
                break;
            }

            case 'image': {
                const src = getAttr(token, 'src') || '';
                const alt = token.content || '';
                const text = alt && src && alt !== src ? `${alt} (${src})` : (src || alt);
                if (text) {
                    children.push({ type: 'text', value: text });
                }
                i++;
                break;
            }

            case 'html_inline': {
                children.push({ type: 'text', value: token.content });
                i++;
                break;
            }

            default: {
                // Skip orphaned close tokens
                if (token.type.endsWith('_close')) {
                    i++;
                    break;
                }
                if (token.content) {
                    children.push({ type: 'text', value: token.content });
                }
                i++;
                break;
            }
        }
    }

    return { children, nextIndex: i };
}

// --------------- helpers ---------------

/**
 * Get attribute value from a markdown-it token.
 */
function getAttr(token, name) {
    if (token.attrGet) return token.attrGet(name);
    if (token.attrs) {
        const attr = token.attrs.find(a => a[0] === name);
        return attr ? attr[1] : null;
    }
    return null;
}

/**
 * Merge consecutive text nodes into one.
 */
function mergeAdjacentText(nodes) {
    if (!nodes || nodes.length <= 1) {
        // Filter single empty text node
        if (nodes && nodes.length === 1 && nodes[0].type === 'text' && nodes[0].value === '') {
            return [];
        }
        return nodes;
    }
    const result = [];
    for (const node of nodes) {
        // Skip empty text nodes
        if (node.type === 'text' && node.value === '') continue;
        if (node.type === 'text' && result.length > 0 && result[result.length - 1].type === 'text') {
            result[result.length - 1].value += node.value;
        } else {
            result.push(node);
        }
    }
    return result;
}
