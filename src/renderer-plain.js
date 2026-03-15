// Plain-text renderer: IR → plain text string
// nodejs: v18.16.0
// tab=4spaces

/**
 * Render an array of IR block nodes as plain text.
 * @param {import('./types.js').IRNode[]} blocks
 * @returns {string}
 */
export function renderPlain(blocks) {
    if (!blocks || blocks.length === 0) return '';
    return blocks.map(renderBlockPlain).join('\n\n');
}

// --------------- block rendering ---------------

function renderBlockPlain(block) {
    switch (block.type) {
        case 'paragraph':
            return renderInlinePlain(block.children);
        case 'heading':
            return renderInlinePlain(block.children);
        case 'list':
            return block.children.map(item => renderListItemPlain(item)).join('\n');
        case 'quote':
            return renderQuotePlain(block);
        case 'code_block':
            return renderCodeBlockPlain(block);
        case 'thematic_break':
            return '---';
        default:
            return renderInlinePlain(block.children || []);
    }
}

function renderListItemPlain(item) {
    const prefix = item.marker + ' ';
    const indent = '  ';
    const renderedBlocks = item.children.map(renderBlockPlain);

    if (renderedBlocks.length === 0) return prefix;

    let result = prefix + renderedBlocks[0];
    for (let i = 1; i < renderedBlocks.length; i++) {
        const indented = renderedBlocks[i].split('\n').map(l => indent + l).join('\n');
        result += '\n' + indented;
    }
    return result;
}

function renderQuotePlain(block) {
    const inner = block.children.map(renderBlockPlain).join('\n\n');
    return inner.split('\n').map(line => {
        return line === '' ? '>' : '> ' + line;
    }).join('\n');
}

function renderCodeBlockPlain(block) {
    const langTag = block.lang || '';
    return '```' + langTag + '\n' + block.value + '\n```';
}

// --------------- inline rendering ---------------

/**
 * Render inline IR nodes as plain text (no formatting markup).
 * @param {import('./types.js').IRNode[]} nodes
 * @returns {string}
 */
export function renderInlinePlain(nodes) {
    if (!nodes || nodes.length === 0) return '';
    return nodes.map(renderInlineNodePlain).join('');
}

function renderInlineNodePlain(node) {
    switch (node.type) {
        case 'text':
            return node.value;
        case 'strong':
            return renderInlinePlain(node.children);
        case 'emphasis':
            return renderInlinePlain(node.children);
        case 'inline_code':
            return node.value;
        case 'link':
            return renderLinkPlain(node);
        case 'soft_break':
        case 'hard_break':
            return '\n';
        default:
            if (node.children) return renderInlinePlain(node.children);
            if (node.value !== undefined) return node.value;
            return '';
    }
}

function renderLinkPlain(node) {
    const href = node.href;
    const labelText = getPlainText(node.children);
    if (!labelText || labelText === href) return href;
    return labelText + ' (' + href + ')';
}

// --------------- helpers ---------------

/**
 * Extract plain text content from inline nodes.
 */
function getPlainText(nodes) {
    if (!nodes) return '';
    return nodes.map(n => {
        if (n.value !== undefined) return n.value;
        if (n.type === 'soft_break' || n.type === 'hard_break') return '\n';
        if (n.children) return getPlainText(n.children);
        return '';
    }).join('');
}
