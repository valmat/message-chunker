// Rich-HTML renderer: IR → safe HTML string
// nodejs: v18.16.0
// tab=4spaces

/**
 * Render an array of IR block nodes as rich-html.
 * @param {import('./types.js').IRNode[]} blocks
 * @returns {string}
 */
export function renderHtml(blocks) {
    if (!blocks || blocks.length === 0) return '';
    return blocks.map(renderBlockHtml).join('\n\n');
}

// --------------- block rendering ---------------

function renderBlockHtml(block) {
    switch (block.type) {
        case 'paragraph':
            return renderInlineHtml(block.children);
        case 'heading':
            return '<b>' + renderInlineHtml(block.children) + '</b>';
        case 'list':
            return block.children.map(item => renderListItemHtml(item)).join('\n');
        case 'quote':
            return renderQuoteHtml(block);
        case 'code_block':
            return renderCodeBlockHtml(block);
        case 'thematic_break':
            return '---';
        default:
            return renderInlineHtml(block.children || []);
    }
}

function renderListItemHtml(item) {
    const prefix = item.marker + ' ';
    const indent = '  ';
    const renderedBlocks = item.children.map(renderBlockHtml);

    if (renderedBlocks.length === 0) return prefix;

    let result = prefix + renderedBlocks[0];
    for (let i = 1; i < renderedBlocks.length; i++) {
        const indented = renderedBlocks[i].split('\n').map(l => indent + l).join('\n');
        result += '\n' + indented;
    }
    return result;
}

function renderQuoteHtml(block) {
    const inner = block.children.map(renderBlockHtml).join('\n\n');
    return inner.split('\n').map(line => {
        return line === '' ? '&gt;' : '&gt; ' + line;
    }).join('\n');
}

function renderCodeBlockHtml(block) {
    const escaped = escapeHtml(block.value);
    if (block.lang) {
        return '<pre><code class="language-' + escapeHtml(block.lang) + '">' + escaped + '</code></pre>';
    }
    return '<pre>' + escaped + '</pre>';
}

// --------------- inline rendering ---------------

/**
 * Render inline IR nodes as rich-html.
 * @param {import('./types.js').IRNode[]} nodes
 * @returns {string}
 */
export function renderInlineHtml(nodes) {
    if (!nodes || nodes.length === 0) return '';
    return nodes.map(renderInlineNodeHtml).join('');
}

function renderInlineNodeHtml(node) {
    switch (node.type) {
        case 'text':
            return escapeHtml(node.value);
        case 'strong':
            return '<b>' + renderInlineHtml(node.children) + '</b>';
        case 'emphasis':
            return '<i>' + renderInlineHtml(node.children) + '</i>';
        case 'inline_code':
            return '<code>' + escapeHtml(node.value) + '</code>';
        case 'link':
            return renderLinkHtml(node);
        case 'soft_break':
        case 'hard_break':
            return '\n';
        default:
            if (node.children) return renderInlineHtml(node.children);
            if (node.value !== undefined) return escapeHtml(node.value);
            return '';
    }
}

function renderLinkHtml(node) {
    const href = node.href;
    const labelText = getPlainText(node.children);
    const isUrlLabel = !labelText || labelText === href;
    const renderedLabel = isUrlLabel
        ? escapeHtml(href)
        : renderInlineHtml(node.children);
    return '<a href="' + escapeHtml(href) + '">' + renderedLabel + '</a>';
}

// --------------- helpers ---------------

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Extract plain text content from inline nodes (for link label comparison).
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
