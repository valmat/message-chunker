// Planner: planDelivery() — strategy escalation, greedy packing, chunk building
// nodejs: v18.16.0
// tab=4spaces

import { normalize } from './normalizer.js';
import { renderHtml, renderInlineHtml } from './renderer-html.js';
import { renderPlain, renderInlinePlain } from './renderer-plain.js';
import {
    validateTransportProfile,
    nextStrategy,
    STRATEGY_LADDER,
} from './types.js';
import {
    splitForcedPlainText,
    splitByParagraphRules,
    unicodeSafeSplit,
    maxOriginalPrefixForHtml,
} from './splitter.js';

/**
 * Build a delivery plan for the given markdown message.
 * @param {import('./types.js').PlanRequest} request
 * @returns {import('./types.js').DeliveryPlan}
 */
export function planDelivery(request) {
    validateTransportProfile(request.transport);

    const ir = normalize(request.markdown);
    return planFromIr(ir, 0, request);
}

/**
 * Core planning engine: run strategy escalation on a (possibly sub-) IR.
 * blockOffset shifts sourceRange paths to refer to the full IR.
 *
 * @param {Object} ir — normalized IR (root node with children)
 * @param {number} blockOffset — offset to add to block indices in sourceRange
 * @param {Object} request — { strategy, preferredMode, transport, markdown }
 * @returns {import('./types.js').DeliveryPlan}
 */
export function planFromIr(ir, blockOffset, request) {
    const budget = request.transport.safeTextBudget;
    const initialMode = resolveMode(request.preferredMode, request.transport);

    if (ir.children.length === 0) {
        return {
            chunks: [],
            diagnostics: buildDiagnostics(request, ir, [], request.strategy, initialMode),
        };
    }

    let strategy = request.strategy;
    while (strategy) {
        const mode = getModeForStrategy(strategy, initialMode);
        const result = tryStrategy(ir, strategy, mode, budget);
        if (result) {
            const chunks = finalizeChunks(result.chunkData, ir, blockOffset);
            return {
                chunks,
                diagnostics: buildDiagnostics(
                    request, ir, chunks, strategy, mode,
                    result.splitBlockTypes || [],
                ),
            };
        }
        strategy = nextStrategy(strategy);
    }

    // Should never reach here — forced-plain-text always produces a plan
    throw new Error('Internal error: failed to build delivery plan');
}

// --------------- mode resolution ---------------

function resolveMode(preferredMode, transport) {
    if (preferredMode === 'plain-text') return 'plain-text';
    if (preferredMode === 'auto') {
        return transport.supportsRichHtml ? 'rich-html' : 'plain-text';
    }
    // 'rich-html'
    return transport.supportsRichHtml ? 'rich-html' : 'plain-text';
}

function getModeForStrategy(strategy, initialMode) {
    if (strategy === 'plain-text' || strategy === 'forced-plain-text') {
        return 'plain-text';
    }
    return initialMode;
}

// --------------- rendering helpers ---------------

function renderBlocks(blocks, mode) {
    return mode === 'rich-html' ? renderHtml(blocks) : renderPlain(blocks);
}

function renderInline(nodes, mode) {
    return mode === 'rich-html' ? renderInlineHtml(nodes) : renderInlinePlain(nodes);
}

// --------------- strategy dispatch ---------------

function tryStrategy(ir, strategy, mode, budget) {
    switch (strategy) {
        case 'preserve':
            return tryPreserve(ir, mode, budget);
        case 'split-blocks':
            return trySplitBlocks(ir, mode, budget);
        case 'split-blocks-soft':
            return trySplitBlocksSoft(ir, mode, budget);
        case 'plain-text':
            return trySplitBlocksSoft(ir, 'plain-text', budget);
        case 'forced-plain-text':
            return doForcedPlainText(ir, budget);
        default:
            return null;
    }
}

// --------------- preserve ---------------

function tryPreserve(ir, mode, budget) {
    const content = renderBlocks(ir.children, mode);
    if (content.length <= budget) {
        return {
            chunkData: [{
                content,
                mode,
                blockStart: 0,
                blockEnd: ir.children.length - 1,
            }],
            splitBlockTypes: [],
        };
    }
    return null;
}

// --------------- split-blocks ---------------

function trySplitBlocks(ir, mode, budget) {
    const rendered = ir.children.map(block => renderBlocks([block], mode));

    // If any single block exceeds budget, escalate
    for (const r of rendered) {
        if (r.length > budget) return null;
    }

    const chunkData = greedyPack(rendered, ir.children, mode, budget);
    return { chunkData, splitBlockTypes: [] };
}

// --------------- split-blocks-soft / plain-text ---------------

function trySplitBlocksSoft(ir, mode, budget) {
    const chunkData = [];
    let currentContent = '';
    let currentBlockStart = 0;
    let currentBlockEnd = -1;
    const splitBlockTypes = new Set();

    function flushCurrent() {
        if (currentContent) {
            chunkData.push({
                content: currentContent,
                mode,
                blockStart: currentBlockStart,
                blockEnd: currentBlockEnd,
            });
            currentContent = '';
            currentBlockEnd = -1;
        }
    }

    for (let i = 0; i < ir.children.length; i++) {
        const block = ir.children[i];
        const blockContent = renderBlocks([block], mode);
        const separator = currentContent ? '\n\n' : '';
        const combined = currentContent + separator + blockContent;

        if (combined.length <= budget) {
            if (currentBlockEnd < 0) currentBlockStart = i;
            currentBlockEnd = i;
            currentContent = combined;
            continue;
        }

        // Doesn't fit with current — flush current chunk
        flushCurrent();

        // Block alone fits?
        if (blockContent.length <= budget) {
            currentBlockStart = i;
            currentBlockEnd = i;
            currentContent = blockContent;
            continue;
        }

        // Block doesn't fit alone — try to split it
        if (!canSplitBlock(block, mode)) return null;

        splitBlockTypes.add(block.type);
        const parts = splitBlockIntoParts(block, budget, mode);
        if (!parts) return null;

        // All parts except the last become their own chunks
        for (let p = 0; p < parts.length - 1; p++) {
            chunkData.push({
                content: parts[p],
                mode,
                blockStart: i,
                blockEnd: i,
            });
        }
        // Last part becomes current (may merge with next block)
        currentBlockStart = i;
        currentBlockEnd = i;
        currentContent = parts[parts.length - 1];
    }

    flushCurrent();
    return { chunkData, splitBlockTypes: [...splitBlockTypes] };
}

function canSplitBlock(block, mode) {
    if (block.type === 'paragraph') return true;
    if (block.type === 'quote') return true;
    if (block.type === 'list') return true;
    if (block.type === 'list_item') return true;
    // code_block: splittable only in plain-text mode
    if (block.type === 'code_block') return mode === 'plain-text';
    return false;
}

/**
 * Split an oversized block into parts that each fit the budget.
 * Returns array of rendered strings, or null if can't split.
 */
function splitBlockIntoParts(block, budget, mode) {
    switch (block.type) {
        case 'paragraph':
            return splitParagraphIntoParts(block, budget, mode);
        case 'quote':
            return splitQuoteIntoParts(block, budget, mode);
        case 'list':
            return splitListIntoParts(block, budget, mode);
        case 'list_item':
            return splitListItemIntoParts(block, budget, mode);
        case 'code_block':
            return splitCodeBlockIntoParts(block, budget);
        default:
            return null;
    }
}

// --------------- paragraph splitting ---------------

function splitParagraphIntoParts(paragraph, budget, mode) {
    const children = paragraph.children;
    const parts = [];
    let remaining = children;

    while (remaining.length > 0) {
        const rendered = renderInline(remaining, mode);
        if (rendered.length <= budget) {
            parts.push(rendered);
            break;
        }

        const split = splitInlineOnce(remaining, budget, mode);
        if (!split) return null;
        parts.push(split.firstContent);
        remaining = split.restChildren;
    }

    return parts;
}

/**
 * Split inline children array: return the longest prefix that fits budget.
 */
function splitInlineOnce(children, budget, mode) {
    let accumulated = '';

    for (let i = 0; i < children.length; i++) {
        const nodeRendered = renderInline([children[i]], mode);
        const newContent = accumulated + nodeRendered;

        if (newContent.length > budget) {
            // Split before this node if we have some content
            if (accumulated.length > 0) {
                return {
                    firstContent: accumulated,
                    restChildren: children.slice(i),
                };
            }

            // This single node doesn't fit — try to split it
            if (children[i].type === 'text') {
                const textSplit = splitTextNode(children[i].value, budget, mode);
                if (textSplit) {
                    return {
                        firstContent: renderInline(
                            [{ type: 'text', value: textSplit[0] }], mode
                        ),
                        restChildren: [
                            { type: 'text', value: textSplit[1] },
                            ...children.slice(i + 1),
                        ],
                    };
                }
            }

            // Atomic inline in rich-html can't be split → escalate
            if (mode === 'rich-html') return null;

            // In plain-text, unwrap and split as text
            const plainValue = renderInline([children[i]], 'plain-text');
            const textSplit = splitByParagraphRules(plainValue, budget);
            if (textSplit) {
                return {
                    firstContent: textSplit[0],
                    restChildren: [
                        { type: 'text', value: textSplit[1] },
                        ...children.slice(i + 1),
                    ],
                };
            }

            return null;
        }

        accumulated = newContent;
    }

    return null; // Everything fits
}

/**
 * Split a text node value to fit within budget, accounting for HTML escaping.
 */
function splitTextNode(textValue, budget, mode) {
    if (mode === 'rich-html') {
        // Find the max original text prefix whose escaped form fits budget
        const maxLen = maxOriginalPrefixForHtml(textValue, budget);
        if (maxLen <= 0 || maxLen >= textValue.length) return null;

        const candidate = textValue.slice(0, maxLen);
        const split = splitByParagraphRules(candidate, candidate.length);
        if (split) return [split[0], split[1] + textValue.slice(maxLen)];

        // No paragraph-rule boundary found, use forced split
        const forced = unicodeSafeSplit(candidate, candidate.length);
        return [forced[0], forced[1] + textValue.slice(maxLen)];
    }

    // plain-text: direct split
    return splitByParagraphRules(textValue, budget);
}

// --------------- quote splitting ---------------

function splitQuoteIntoParts(quote, budget, mode) {
    // Try splitting by inner blocks
    const innerBlocks = quote.children;
    const parts = [];
    let currentBlocks = [];

    for (let i = 0; i < innerBlocks.length; i++) {
        currentBlocks.push(innerBlocks[i]);
        const testQuote = { type: 'quote', children: currentBlocks };
        const rendered = renderBlocks([testQuote], mode);

        if (rendered.length > budget) {
            if (currentBlocks.length > 1) {
                // Back up: flush previous blocks
                currentBlocks.pop();
                const flushQuote = { type: 'quote', children: [...currentBlocks] };
                parts.push(renderBlocks([flushQuote], mode));
                currentBlocks = [innerBlocks[i]];

                // Check if single inner block fits
                const singleQuote = { type: 'quote', children: [innerBlocks[i]] };
                const singleRendered = renderBlocks([singleQuote], mode);
                if (singleRendered.length > budget) {
                    // Try splitting the inner block (if paragraph)
                    if (innerBlocks[i].type === 'paragraph') {
                        const subParts = splitParagraphForQuote(innerBlocks[i], budget, mode);
                        if (!subParts) return null;
                        for (const sp of subParts.slice(0, -1)) parts.push(sp);
                        currentBlocks = []; // Will be set from last subpart below
                        // Reconstruct last part as a paragraph in a quote
                        // Actually, subParts are already rendered strings with quote prefix
                        // Push last one and start fresh
                        parts.push(subParts[subParts.length - 1]);
                        currentBlocks = [];
                    } else {
                        return null;
                    }
                }
            } else {
                // Single inner block too large
                if (innerBlocks[i].type === 'paragraph') {
                    const subParts = splitParagraphForQuote(innerBlocks[i], budget, mode);
                    if (!subParts) return null;
                    for (const sp of subParts.slice(0, -1)) parts.push(sp);
                    parts.push(subParts[subParts.length - 1]);
                    currentBlocks = [];
                } else {
                    return null;
                }
            }
        }
    }

    if (currentBlocks.length > 0) {
        const q = { type: 'quote', children: currentBlocks };
        parts.push(renderBlocks([q], mode));
    }

    return parts.length > 0 ? parts : null;
}

function splitParagraphForQuote(paragraph, budget, mode) {
    // Each part becomes a paragraph inside a quote
    const prefix = mode === 'rich-html' ? '&gt; ' : '> ';
    const innerBudget = budget - prefix.length;
    if (innerBudget <= 0) return null;

    const paraParts = splitParagraphIntoParts(paragraph, innerBudget, mode);
    if (!paraParts) return null;

    return paraParts.map(content => prefix + content);
}

// --------------- list splitting ---------------

function splitListIntoParts(list, budget, mode) {
    const parts = [];
    let currentItems = [];

    for (let i = 0; i < list.children.length; i++) {
        const item = list.children[i];
        currentItems.push(item);
        const testList = { ...list, children: currentItems };
        const rendered = renderBlocks([testList], mode);

        if (rendered.length > budget) {
            if (currentItems.length > 1) {
                currentItems.pop();
                const flushList = { ...list, children: [...currentItems] };
                parts.push(renderBlocks([flushList], mode));
                currentItems = [item];

                // Check single item
                const singleList = { ...list, children: [item] };
                if (renderBlocks([singleList], mode).length > budget) {
                    const itemParts = splitListItemIntoParts(item, budget, mode);
                    if (!itemParts) return null;
                    for (const ip of itemParts) parts.push(ip);
                    currentItems = [];
                }
            } else {
                // Single item too large
                const itemParts = splitListItemIntoParts(item, budget, mode);
                if (!itemParts) return null;
                for (const ip of itemParts) parts.push(ip);
                currentItems = [];
            }
        }
    }

    if (currentItems.length > 0) {
        const l = { ...list, children: currentItems };
        parts.push(renderBlocks([l], mode));
    }

    return parts.length > 0 ? parts : null;
}

function splitListItemIntoParts(item, budget, mode) {
    // List item rendered as: "marker content\n  continuation"
    // Try splitting inner blocks
    const marker = (item.marker || '-') + ' ';
    const indent = '  ';

    if (item.children.length === 0) return null;

    // Render first block with marker
    const firstBlockContent = renderBlocks([item.children[0]], mode);
    const firstLine = marker + firstBlockContent;

    if (firstLine.length > budget) {
        // First block with marker doesn't fit — split the inner block
        const innerBudget = budget - marker.length;
        if (innerBudget <= 0) return null;

        if (item.children[0].type === 'paragraph') {
            const paraParts = splitParagraphIntoParts(item.children[0], innerBudget, mode);
            if (!paraParts) return null;
            const parts = [];
            for (let p = 0; p < paraParts.length; p++) {
                parts.push(marker + paraParts[p]);
            }
            // Remaining inner blocks as continuation
            for (let b = 1; b < item.children.length; b++) {
                const cont = renderBlocks([item.children[b]], mode);
                const indented = cont.split('\n').map(l => indent + l).join('\n');
                parts.push(marker + indented);
            }
            return parts;
        }
        return null;
    }

    // First block fits with marker; try adding more inner blocks
    const parts = [];
    let current = firstLine;

    for (let b = 1; b < item.children.length; b++) {
        const cont = renderBlocks([item.children[b]], mode);
        const indented = cont.split('\n').map(l => indent + l).join('\n');
        const combined = current + '\n' + indented;

        if (combined.length > budget) {
            parts.push(current);
            current = marker + indented.trimStart();
        } else {
            current = combined;
        }
    }

    if (current) parts.push(current);
    return parts.length > 1 ? parts : null;
}

// --------------- code block splitting (plain-text only) ---------------

function splitCodeBlockIntoParts(block, budget) {
    const lang = block.lang || '';
    const fenceOpen = '```' + lang + '\n';
    const fenceClose = '\n```';
    const overhead = fenceOpen.length + fenceClose.length;
    const contentBudget = budget - overhead;

    if (contentBudget <= 0) return null;

    const parts = [];
    let remaining = block.value;

    while (remaining.length > contentBudget) {
        const candidate = remaining.slice(0, contentBudget);
        const lastNl = candidate.lastIndexOf('\n');
        let splitPos;
        if (lastNl > 0) {
            splitPos = lastNl;
        } else {
            splitPos = unicodeSafeSplit(remaining, contentBudget)[0].length;
        }

        parts.push(fenceOpen + remaining.slice(0, splitPos) + fenceClose);
        remaining = remaining.slice(splitPos + (remaining[splitPos] === '\n' ? 1 : 0));
    }

    if (remaining) {
        parts.push(fenceOpen + remaining + fenceClose);
    }

    return parts.length > 0 ? parts : null;
}

// --------------- forced-plain-text ---------------

function doForcedPlainText(ir, budget) {
    const chunkData = [];
    let currentContent = '';
    let currentBlockStart = 0;
    let currentBlockEnd = -1;
    const splitBlockTypes = new Set();

    function flushCurrent() {
        if (currentContent) {
            chunkData.push({
                content: currentContent,
                mode: 'plain-text',
                blockStart: currentBlockStart,
                blockEnd: currentBlockEnd,
            });
            currentContent = '';
            currentBlockEnd = -1;
        }
    }

    for (let i = 0; i < ir.children.length; i++) {
        const block = ir.children[i];
        let blockContent;

        // Special handling for code blocks: keep fences balanced
        if (block.type === 'code_block') {
            blockContent = renderBlocks([block], 'plain-text');
            const separator = currentContent ? '\n\n' : '';
            const combined = currentContent + separator + blockContent;

            if (combined.length <= budget) {
                if (currentBlockEnd < 0) currentBlockStart = i;
                currentBlockEnd = i;
                currentContent = combined;
                continue;
            }

            flushCurrent();

            if (blockContent.length <= budget) {
                currentBlockStart = i;
                currentBlockEnd = i;
                currentContent = blockContent;
                continue;
            }

            // Split code block with balanced fences
            splitBlockTypes.add('code_block');
            const codeParts = splitCodeBlockIntoParts(block, budget);
            if (codeParts) {
                for (let p = 0; p < codeParts.length - 1; p++) {
                    chunkData.push({
                        content: codeParts[p],
                        mode: 'plain-text',
                        blockStart: i,
                        blockEnd: i,
                    });
                }
                currentBlockStart = i;
                currentBlockEnd = i;
                currentContent = codeParts[codeParts.length - 1];
            } else {
                // Fallback: split as raw text
                currentBlockStart = i;
                currentBlockEnd = i;
                let rem = blockContent;
                while (rem.length > budget) {
                    const split = splitForcedPlainText(rem, budget);
                    if (!split) break;
                    chunkData.push({
                        content: split[0],
                        mode: 'plain-text',
                        blockStart: i,
                        blockEnd: i,
                    });
                    rem = split[1];
                }
                currentContent = rem;
            }
            continue;
        }

        // Regular block
        blockContent = renderBlocks([block], 'plain-text');
        const separator = currentContent ? '\n\n' : '';
        const combined = currentContent + separator + blockContent;

        if (combined.length <= budget) {
            if (currentBlockEnd < 0) currentBlockStart = i;
            currentBlockEnd = i;
            currentContent = combined;
            continue;
        }

        flushCurrent();

        if (blockContent.length <= budget) {
            currentBlockStart = i;
            currentBlockEnd = i;
            currentContent = blockContent;
            continue;
        }

        // Block too large — split using forced rules
        splitBlockTypes.add(block.type);
        currentBlockStart = i;
        currentBlockEnd = i;
        let rem = blockContent;
        while (rem.length > budget) {
            const split = splitForcedPlainText(rem, budget);
            if (!split) break;
            chunkData.push({
                content: split[0],
                mode: 'plain-text',
                blockStart: i,
                blockEnd: i,
            });
            rem = split[1];
        }
        currentContent = rem;
    }

    flushCurrent();
    return { chunkData, splitBlockTypes: [...splitBlockTypes] };
}

// --------------- greedy packing ---------------

function greedyPack(renderedBlocks, irBlocks, mode, budget) {
    const chunkData = [];
    let currentContent = '';
    let currentBlockStart = 0;
    let currentBlockEnd = -1;

    for (let i = 0; i < renderedBlocks.length; i++) {
        const blockContent = renderedBlocks[i];
        const separator = currentContent ? '\n\n' : '';
        const combined = currentContent + separator + blockContent;

        if (combined.length <= budget) {
            if (currentBlockEnd < 0) currentBlockStart = i;
            currentBlockEnd = i;
            currentContent = combined;
        } else {
            if (currentContent) {
                chunkData.push({
                    content: currentContent,
                    mode,
                    blockStart: currentBlockStart,
                    blockEnd: currentBlockEnd,
                });
            }
            currentBlockStart = i;
            currentBlockEnd = i;
            currentContent = blockContent;
        }
    }

    if (currentContent) {
        chunkData.push({
            content: currentContent,
            mode,
            blockStart: currentBlockStart,
            blockEnd: currentBlockEnd,
        });
    }

    return chunkData;
}

// --------------- source range ---------------

function findFirstLeafCursor(node, basePath) {
    if (node.type === 'text' || node.type === 'inline_code' || node.type === 'code_block') {
        return { path: basePath, offsetUtf16: 0 };
    }
    if (node.type === 'thematic_break') {
        return { path: basePath, offsetUtf16: 0 };
    }
    if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
            const cursor = findFirstLeafCursor(node.children[i], [...basePath, i]);
            if (cursor) return cursor;
        }
    }
    return { path: basePath, offsetUtf16: 0 };
}

function findLastLeafCursor(node, basePath) {
    if (node.type === 'text' || node.type === 'inline_code') {
        return { path: basePath, offsetUtf16: (node.value || '').length };
    }
    if (node.type === 'code_block') {
        return { path: basePath, offsetUtf16: (node.value || '').length };
    }
    if (node.type === 'thematic_break') {
        return { path: basePath, offsetUtf16: 0 };
    }
    if (node.children) {
        for (let i = node.children.length - 1; i >= 0; i--) {
            const cursor = findLastLeafCursor(node.children[i], [...basePath, i]);
            if (cursor) return cursor;
        }
    }
    return { path: basePath, offsetUtf16: 0 };
}

function computeSourceRange(ir, blockStart, blockEnd) {
    return {
        start: findFirstLeafCursor(ir.children[blockStart], [blockStart]),
        end: findLastLeafCursor(ir.children[blockEnd], [blockEnd]),
    };
}

// --------------- finalize chunks ---------------

function finalizeChunks(chunkData, ir, blockOffset = 0) {
    const total = chunkData.length;
    return chunkData.map((cd, index) => {
        const sr = computeSourceRange(ir, cd.blockStart, cd.blockEnd);
        if (blockOffset > 0) {
            sr.start.path[0] += blockOffset;
            sr.end.path[0] += blockOffset;
        }
        return {
            index,
            total,
            mode: cd.mode,
            content: cd.content,
            estimatedLength: cd.content.length,
            sourceRange: sr,
        };
    });
}

// --------------- diagnostics ---------------

function buildDiagnostics(request, ir, chunks, usedStrategy, usedMode, splitBlockTypes = []) {
    const plainEstimate = renderBlocks(ir.children, 'plain-text').length;
    const hadDegradation = usedStrategy !== request.strategy ||
        (usedMode === 'plain-text' && request.preferredMode !== 'plain-text');
    const degradedToPlainText = usedMode === 'plain-text' &&
        request.preferredMode !== 'plain-text';

    return {
        sourceLength: request.markdown.length,
        plainTextLengthEstimate: plainEstimate,
        normalizedBlockCount: ir.children.length,
        chunkCount: chunks.length,
        requestedStrategy: request.strategy,
        usedStrategy,
        requestedMode: request.preferredMode,
        usedMode,
        hadDegradation,
        degradedToPlainText,
        splitBlockTypes,
    };
}
