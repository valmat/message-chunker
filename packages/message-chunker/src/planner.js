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
    let currentSourceStart = null; // precise start cursor for split fragment tail
    const splitBlockTypes = new Set();

    function flushCurrent() {
        if (currentContent) {
            chunkData.push({
                content: currentContent,
                mode,
                blockStart: currentBlockStart,
                blockEnd: currentBlockEnd,
                sourceStart: currentSourceStart,
            });
            currentContent = '';
            currentBlockEnd = -1;
            currentSourceStart = null;
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
        const fragments = splitBlockIntoFragments(block, budget, mode);
        if (!fragments) return null;

        // All fragments except the last become their own chunks
        for (let p = 0; p < fragments.length - 1; p++) {
            const frag = fragments[p];
            chunkData.push({
                content: frag.content,
                mode,
                blockStart: i,
                blockEnd: i,
                sourceStart: prependBlockIdx(frag.cursorStart, i),
                sourceEnd: prependBlockIdx(frag.cursorEnd, i),
            });
        }
        // Last fragment becomes current (may merge with next block)
        const lastFrag = fragments[fragments.length - 1];
        currentBlockStart = i;
        currentBlockEnd = i;
        currentContent = lastFrag.content;
        currentSourceStart = prependBlockIdx(lastFrag.cursorStart, i);
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
 * Split an oversized block into fragments with cursor metadata.
 * Returns array of { content, cursorStart, cursorEnd } where cursor paths
 * are relative to the block (not including the block's own index).
 */
function splitBlockIntoFragments(block, budget, mode) {
    switch (block.type) {
        case 'paragraph':
            return splitParagraphIntoFragments(block, budget, mode);
        case 'quote':
            return splitQuoteIntoFragments(block, budget, mode);
        case 'list':
            return splitListIntoFragments(block, budget, mode);
        case 'list_item':
            return splitListItemIntoFragments(block, budget, mode);
        case 'code_block':
            return splitCodeBlockIntoFragments(block, budget);
        default:
            return null;
    }
}

// --------------- paragraph splitting ---------------

function splitParagraphIntoFragments(paragraph, budget, mode) {
    const children = paragraph.children;
    const fragments = [];
    let remaining = children;
    let textOffset = 0;

    while (remaining.length > 0) {
        const rendered = renderInline(remaining, mode);
        if (rendered.length <= budget) {
            const textLen = inlineTextLength(remaining);
            fragments.push({
                content: rendered,
                cursorStart: inlineOffsetToCursor(children, textOffset, false),
                cursorEnd: inlineOffsetToCursor(children, textOffset + textLen, true),
            });
            break;
        }

        const prevLen = inlineTextLength(remaining);
        const split = splitInlineOnce(remaining, budget, mode);
        if (!split) return null;

        const afterLen = inlineTextLength(split.restChildren);
        const consumed = prevLen - afterLen;

        fragments.push({
            content: split.firstContent,
            cursorStart: inlineOffsetToCursor(children, textOffset, false),
            cursorEnd: inlineOffsetToCursor(children, textOffset + consumed, true),
        });

        textOffset += consumed;
        remaining = split.restChildren;
    }

    return fragments.length > 0 ? fragments : null;
}

/**
 * Build restChildren array, omitting empty text remainder.
 */
function buildRestChildren(remainder, children, fromIndex) {
    const rest = [];
    if (remainder.length > 0) {
        rest.push({ type: 'text', value: remainder });
    }
    for (let j = fromIndex; j < children.length; j++) {
        rest.push(children[j]);
    }
    return rest;
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
            if (accumulated.length > 0) {
                // Try to take a partial piece from a text node to fill remaining budget
                if (children[i].type === 'text') {
                    const remainingBudget = budget - accumulated.length;
                    const textSplit = splitTextNode(children[i].value, remainingBudget, mode);
                    if (textSplit && textSplit[0].length > 0) {
                        const partialRendered = renderInline(
                            [{ type: 'text', value: textSplit[0] }], mode
                        );
                        if ((accumulated + partialRendered).length <= budget) {
                            return {
                                firstContent: accumulated + partialRendered,
                                restChildren: buildRestChildren(textSplit[1], children, i + 1),
                            };
                        }
                    }
                }
                // Fall back to splitting before this node
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
                        restChildren: buildRestChildren(textSplit[1], children, i + 1),
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
                    restChildren: buildRestChildren(textSplit[1], children, i + 1),
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

function splitQuoteIntoFragments(quote, budget, mode) {
    const innerBlocks = quote.children;
    const fragments = [];
    let currentBlocks = [];
    let currentStartInnerIdx = 0;

    for (let i = 0; i < innerBlocks.length; i++) {
        currentBlocks.push(innerBlocks[i]);
        const testQuote = { type: 'quote', children: currentBlocks };
        const rendered = renderBlocks([testQuote], mode);

        if (rendered.length > budget) {
            if (currentBlocks.length > 1) {
                // Back up: flush previous blocks
                currentBlocks.pop();
                const flushQuote = { type: 'quote', children: [...currentBlocks] };
                fragments.push({
                    content: renderBlocks([flushQuote], mode),
                    cursorStart: findFirstLeafCursorRel(quote, [currentStartInnerIdx]),
                    cursorEnd: findLastLeafCursorRel(quote, [i - 1]),
                });
                currentBlocks = [innerBlocks[i]];
                currentStartInnerIdx = i;

                // Check if single inner block fits
                const singleQuote = { type: 'quote', children: [innerBlocks[i]] };
                const singleRendered = renderBlocks([singleQuote], mode);
                if (singleRendered.length > budget) {
                    if (innerBlocks[i].type === 'paragraph') {
                        const subFrags = splitParagraphForQuoteFragments(innerBlocks[i], budget, mode, i);
                        if (!subFrags) return null;
                        for (const sf of subFrags) fragments.push(sf);
                        currentBlocks = [];
                        currentStartInnerIdx = i + 1;
                    } else {
                        return null;
                    }
                }
            } else {
                // Single inner block too large
                if (innerBlocks[i].type === 'paragraph') {
                    const subFrags = splitParagraphForQuoteFragments(innerBlocks[i], budget, mode, i);
                    if (!subFrags) return null;
                    for (const sf of subFrags) fragments.push(sf);
                    currentBlocks = [];
                    currentStartInnerIdx = i + 1;
                } else {
                    return null;
                }
            }
        }
    }

    if (currentBlocks.length > 0) {
        const q = { type: 'quote', children: currentBlocks };
        fragments.push({
            content: renderBlocks([q], mode),
            cursorStart: findFirstLeafCursorRel(quote, [currentStartInnerIdx]),
            cursorEnd: findLastLeafCursorRel(quote, [innerBlocks.length - 1]),
        });
    }

    return fragments.length > 0 ? fragments : null;
}

function splitParagraphForQuoteFragments(paragraph, budget, mode, innerBlockIdx) {
    const prefix = mode === 'rich-html' ? '&gt; ' : '> ';
    const innerBudget = budget - prefix.length;
    if (innerBudget <= 0) return null;

    const paraFragments = splitParagraphIntoFragments(paragraph, innerBudget, mode);
    if (!paraFragments) return null;

    return paraFragments.map(frag => ({
        content: prefix + frag.content,
        cursorStart: { path: [innerBlockIdx, ...frag.cursorStart.path], offsetUtf16: frag.cursorStart.offsetUtf16 },
        cursorEnd: { path: [innerBlockIdx, ...frag.cursorEnd.path], offsetUtf16: frag.cursorEnd.offsetUtf16 },
    }));
}

// --------------- list splitting ---------------

function splitListIntoFragments(list, budget, mode) {
    const fragments = [];
    let currentItems = [];
    let currentStartItemIdx = 0;

    for (let i = 0; i < list.children.length; i++) {
        const item = list.children[i];
        currentItems.push(item);
        const testList = { ...list, children: currentItems };
        const rendered = renderBlocks([testList], mode);

        if (rendered.length > budget) {
            if (currentItems.length > 1) {
                currentItems.pop();
                const flushList = { ...list, children: [...currentItems] };
                fragments.push({
                    content: renderBlocks([flushList], mode),
                    cursorStart: findFirstLeafCursorRel(list, [currentStartItemIdx]),
                    cursorEnd: findLastLeafCursorRel(list, [i - 1]),
                });
                currentItems = [item];
                currentStartItemIdx = i;

                // Check single item
                const singleList = { ...list, children: [item] };
                if (renderBlocks([singleList], mode).length > budget) {
                    const itemFrags = splitListItemForListFragments(item, budget, mode, i);
                    if (!itemFrags) return null;
                    for (const ifr of itemFrags) fragments.push(ifr);
                    currentItems = [];
                    currentStartItemIdx = i + 1;
                }
            } else {
                // Single item too large
                const itemFrags = splitListItemForListFragments(item, budget, mode, i);
                if (!itemFrags) return null;
                for (const ifr of itemFrags) fragments.push(ifr);
                currentItems = [];
                currentStartItemIdx = i + 1;
            }
        }
    }

    if (currentItems.length > 0) {
        const l = { ...list, children: currentItems };
        fragments.push({
            content: renderBlocks([l], mode),
            cursorStart: findFirstLeafCursorRel(list, [currentStartItemIdx]),
            cursorEnd: findLastLeafCursorRel(list, [list.children.length - 1]),
        });
    }

    return fragments.length > 0 ? fragments : null;
}

function splitListItemForListFragments(item, budget, mode, itemIdx) {
    const itemFrags = splitListItemIntoFragments(item, budget, mode);
    if (!itemFrags) return null;
    // Prepend itemIdx to each fragment's cursor path
    return itemFrags.map(frag => ({
        content: frag.content,
        cursorStart: { path: [itemIdx, ...frag.cursorStart.path], offsetUtf16: frag.cursorStart.offsetUtf16 },
        cursorEnd: { path: [itemIdx, ...frag.cursorEnd.path], offsetUtf16: frag.cursorEnd.offsetUtf16 },
    }));
}

function renderStandaloneListItemBlockContent(block, marker, indent, mode) {
    const content = renderBlocks([block], mode);
    const indented = content.split('\n').map(line => indent + line).join('\n');
    return marker + indented.trimStart();
}

function splitStandaloneListItemBlockIntoFragments(item, blockIdx, budget, mode, marker, indent) {
    const block = item.children[blockIdx];
    const content = renderStandaloneListItemBlockContent(block, marker, indent, mode);

    if (content.length <= budget) {
        return [{
            content,
            cursorStart: findFirstLeafCursorRel(item, [blockIdx]),
            cursorEnd: findLastLeafCursorRel(item, [blockIdx]),
        }];
    }

    const innerBudget = budget - marker.length;
    if (innerBudget <= 0) return null;

    if (block.type === 'paragraph') {
        const paraFrags = splitParagraphIntoFragments(block, innerBudget, mode);
        if (!paraFrags) return null;

        return paraFrags.map(frag => ({
            content: marker + frag.content,
            cursorStart: { path: [blockIdx, ...frag.cursorStart.path], offsetUtf16: frag.cursorStart.offsetUtf16 },
            cursorEnd: { path: [blockIdx, ...frag.cursorEnd.path], offsetUtf16: frag.cursorEnd.offsetUtf16 },
        }));
    }

    return null;
}

function splitListItemIntoFragments(item, budget, mode) {
    const marker = (item.marker || '-') + ' ';
    const indent = '  ';

    if (item.children.length === 0) return null;

    const fragments = [];
    const firstBlockFragments = splitStandaloneListItemBlockIntoFragments(item, 0, budget, mode, marker, indent);
    if (!firstBlockFragments) return null;

    let current = '';
    let currentStartBlock = 0;

    if (firstBlockFragments.length === 1) {
        current = firstBlockFragments[0].content;
    } else {
        fragments.push(...firstBlockFragments);
        currentStartBlock = 1;
    }

    // First block fits with marker; try adding more inner blocks
    for (let b = 1; b < item.children.length; b++) {
        const cont = renderBlocks([item.children[b]], mode);
        const indented = cont.split('\n').map(l => indent + l).join('\n');
        const standaloneFragments = splitStandaloneListItemBlockIntoFragments(item, b, budget, mode, marker, indent);
        if (!standaloneFragments) return null;

        if (!current) {
            if (standaloneFragments.length === 1) {
                current = standaloneFragments[0].content;
                currentStartBlock = b;
            } else {
                fragments.push(...standaloneFragments);
                currentStartBlock = b + 1;
            }
            continue;
        }

        const combined = current + '\n' + indented;

        if (combined.length > budget) {
            fragments.push({
                content: current,
                cursorStart: findFirstLeafCursorRel(item, [currentStartBlock]),
                cursorEnd: findLastLeafCursorRel(item, [b - 1]),
            });

            if (standaloneFragments.length === 1) {
                current = standaloneFragments[0].content;
                currentStartBlock = b;
            } else {
                fragments.push(...standaloneFragments);
                current = '';
                currentStartBlock = b + 1;
            }
        } else {
            current = combined;
        }
    }

    if (current) {
        fragments.push({
            content: current,
            cursorStart: findFirstLeafCursorRel(item, [currentStartBlock]),
            cursorEnd: findLastLeafCursorRel(item, [item.children.length - 1]),
        });
    }

    return fragments.length > 1 ? fragments : null;
}

// --------------- code block splitting (plain-text only) ---------------

function splitCodeBlockIntoFragments(block, budget) {
    const lang = block.lang || '';
    const fenceOpen = '```' + lang + '\n';
    const fenceClose = '\n```';
    const overhead = fenceOpen.length + fenceClose.length;
    const contentBudget = budget - overhead;

    if (contentBudget <= 0) return null;

    const fragments = [];
    let remaining = block.value;
    let valueOffset = 0;

    while (remaining.length > contentBudget) {
        const candidate = remaining.slice(0, contentBudget);
        const lastNl = candidate.lastIndexOf('\n');
        let splitPos;
        if (lastNl > 0) {
            splitPos = lastNl;
        } else {
            splitPos = unicodeSafeSplit(remaining, contentBudget)[0].length;
        }

        fragments.push({
            content: fenceOpen + remaining.slice(0, splitPos) + fenceClose,
            cursorStart: { path: [], offsetUtf16: valueOffset },
            cursorEnd: { path: [], offsetUtf16: valueOffset + splitPos },
        });

        const skip = remaining[splitPos] === '\n' ? 1 : 0;
        valueOffset += splitPos + skip;
        remaining = remaining.slice(splitPos + skip);
    }

    if (remaining) {
        fragments.push({
            content: fenceOpen + remaining + fenceClose,
            cursorStart: { path: [], offsetUtf16: valueOffset },
            cursorEnd: { path: [], offsetUtf16: valueOffset + remaining.length },
        });
    }

    return fragments.length > 0 ? fragments : null;
}

// --------------- forced-plain-text ---------------

function doForcedPlainText(ir, budget) {
    const chunkData = [];
    let currentContent = '';
    let currentBlockStart = 0;
    let currentBlockEnd = -1;
    let currentSourceStart = null;
    const splitBlockTypes = new Set();

    function flushCurrent() {
        if (currentContent) {
            chunkData.push({
                content: currentContent,
                mode: 'plain-text',
                blockStart: currentBlockStart,
                blockEnd: currentBlockEnd,
                sourceStart: currentSourceStart,
            });
            currentContent = '';
            currentBlockEnd = -1;
            currentSourceStart = null;
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
            const codeFrags = splitCodeBlockIntoFragments(block, budget);
            if (codeFrags) {
                for (let p = 0; p < codeFrags.length - 1; p++) {
                    chunkData.push({
                        content: codeFrags[p].content,
                        mode: 'plain-text',
                        blockStart: i,
                        blockEnd: i,
                        sourceStart: prependBlockIdx(codeFrags[p].cursorStart, i),
                        sourceEnd: prependBlockIdx(codeFrags[p].cursorEnd, i),
                    });
                }
                const lastFrag = codeFrags[codeFrags.length - 1];
                currentBlockStart = i;
                currentBlockEnd = i;
                currentContent = lastFrag.content;
                currentSourceStart = prependBlockIdx(lastFrag.cursorStart, i);
            } else {
                // Fallback: split as raw text
                currentBlockStart = i;
                currentBlockEnd = i;
                let rem = blockContent;
                let renderedOffset = 0;
                while (rem.length > budget) {
                    const split = splitForcedPlainText(rem, budget);
                    if (!split) break;
                    chunkData.push({
                        content: split[0],
                        mode: 'plain-text',
                        blockStart: i,
                        blockEnd: i,
                        sourceStart: codeBlockRenderedOffsetToCursor(block, renderedOffset, i),
                        sourceEnd: codeBlockRenderedOffsetToCursor(block, renderedOffset + split[0].length, i),
                    });
                    renderedOffset += split[0].length;
                    rem = split[1];
                }
                currentContent = rem;
                currentSourceStart = codeBlockRenderedOffsetToCursor(block, renderedOffset, i);
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
        let renderedOffset = 0;

        while (rem.length > budget) {
            const split = splitForcedPlainText(rem, budget);
            if (!split) break;

            const srcStart = blockRenderedOffsetToCursor(block, renderedOffset, i);
            renderedOffset += split[0].length;
            const srcEnd = blockRenderedOffsetToCursor(block, renderedOffset, i);

            chunkData.push({
                content: split[0],
                mode: 'plain-text',
                blockStart: i,
                blockEnd: i,
                sourceStart: srcStart,
                sourceEnd: srcEnd,
            });
            rem = split[1];
        }
        currentContent = rem;
        currentSourceStart = blockRenderedOffsetToCursor(block, renderedOffset, i);
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

// =============== inline text helpers ===============

/**
 * Count total text characters in an inline node tree.
 * Counts text values, inline_code values, and breaks as 1 char each.
 */
function inlineTextLength(nodes) {
    let len = 0;
    for (const node of nodes) {
        if (node.type === 'text' || node.type === 'inline_code') {
            len += (node.value || '').length;
        } else if (node.type === 'soft_break' || node.type === 'hard_break') {
            len += 1;
        } else if (node.children) {
            len += inlineTextLength(node.children);
        }
    }
    return len;
}

/**
 * Convert a text offset within inline children to a SourceCursor (path + offsetUtf16).
 * @param {Array} nodes — inline children of a paragraph
 * @param {number} offset — text offset (counting text/inline_code values + 1 per break)
 * @param {boolean} isEnd — if true, uses <= boundary (for end cursors); if false, uses < (for start cursors)
 * @returns {{ path: number[], offsetUtf16: number }}
 */
function inlineOffsetToCursor(nodes, offset, isEnd) {
    let remaining = offset;
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.type === 'text' || node.type === 'inline_code') {
            const len = (node.value || '').length;
            if (isEnd ? remaining <= len : remaining < len) {
                return { path: [i], offsetUtf16: remaining };
            }
            remaining -= len;
        } else if (node.type === 'soft_break' || node.type === 'hard_break') {
            if (remaining === 0) {
                return { path: [i], offsetUtf16: 0 };
            }
            remaining -= 1;
        } else if (node.children) {
            const childLen = inlineTextLength(node.children);
            if (isEnd ? remaining <= childLen : remaining < childLen) {
                const inner = inlineOffsetToCursor(node.children, remaining, isEnd);
                return { path: [i, ...inner.path], offsetUtf16: inner.offsetUtf16 };
            }
            remaining -= childLen;
        }
    }
    // Past the end — return end of last leaf
    return endCursorForInline(nodes);
}

/**
 * Cursor pointing past the end of the last leaf in an inline node array.
 */
function endCursorForInline(nodes) {
    if (!nodes || nodes.length === 0) return { path: [], offsetUtf16: 0 };
    const lastIdx = nodes.length - 1;
    const last = nodes[lastIdx];
    if (last.type === 'text' || last.type === 'inline_code') {
        return { path: [lastIdx], offsetUtf16: (last.value || '').length };
    }
    if (last.children && last.children.length > 0) {
        const inner = endCursorForInline(last.children);
        return { path: [lastIdx, ...inner.path], offsetUtf16: inner.offsetUtf16 };
    }
    return { path: [lastIdx], offsetUtf16: 0 };
}

// =============== cursor helpers ===============

/**
 * Prepend a block index to a cursor's path.
 */
function prependBlockIdx(cursor, blockIdx) {
    return { path: [blockIdx, ...cursor.path], offsetUtf16: cursor.offsetUtf16 };
}

/**
 * Find cursor for first leaf of a descendant, starting from a partial path.
 * Used for quote/list inter-element splits.
 */
function findFirstLeafCursorRel(block, startPath) {
    let node = block;
    for (const idx of startPath) {
        if (!node.children || idx >= node.children.length) {
            return { path: startPath, offsetUtf16: 0 };
        }
        node = node.children[idx];
    }
    const inner = findFirstLeafCursorInner(node, []);
    return { path: [...startPath, ...inner.path], offsetUtf16: inner.offsetUtf16 };
}

function findLastLeafCursorRel(block, endPath) {
    let node = block;
    for (const idx of endPath) {
        if (!node.children || idx >= node.children.length) {
            return { path: endPath, offsetUtf16: 0 };
        }
        node = node.children[idx];
    }
    const inner = findLastLeafCursorInner(node, []);
    return { path: [...endPath, ...inner.path], offsetUtf16: inner.offsetUtf16 };
}

function findFirstLeafCursorInner(node, basePath) {
    if (node.type === 'text' || node.type === 'inline_code' || node.type === 'code_block') {
        return { path: basePath, offsetUtf16: 0 };
    }
    if (node.type === 'thematic_break') {
        return { path: basePath, offsetUtf16: 0 };
    }
    if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
            const cursor = findFirstLeafCursorInner(node.children[i], [...basePath, i]);
            if (cursor) return cursor;
        }
    }
    return { path: basePath, offsetUtf16: 0 };
}

function findLastLeafCursorInner(node, basePath) {
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
            const cursor = findLastLeafCursorInner(node.children[i], [...basePath, i]);
            if (cursor) return cursor;
        }
    }
    return { path: basePath, offsetUtf16: 0 };
}

/**
 * Convert a rendered plain-text offset of a paragraph to a full SourceCursor.
 * For paragraphs in plain-text, rendered text closely matches inline text content
 * (exact for text/strong/emphasis/inline_code, approximate for links).
 */
function paragraphRenderedOffsetToCursor(paragraph, renderedOffset, blockIdx) {
    let pos = 0;
    let textPos = 0;
    const children = paragraph.children;

    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const rendered = renderInline([child], 'plain-text');
        const textLen = inlineTextLength([child]);

        if (pos + rendered.length > renderedOffset) {
            const offsetInRendered = renderedOffset - pos;
            if (child.type === 'text' || child.type === 'inline_code') {
                return { path: [blockIdx, i], offsetUtf16: offsetInRendered };
            }
            if (child.type === 'soft_break' || child.type === 'hard_break') {
                return { path: [blockIdx, i], offsetUtf16: 0 };
            }
            if (child.children) {
                // For strong/emphasis: rendered = inner content, so offset maps 1:1
                // For links: rendered = "label (URL)" — approximate
                if (child.type === 'link') {
                    const ratio = rendered.length > 0 ? offsetInRendered / rendered.length : 0;
                    const approxTextOff = Math.min(Math.round(ratio * textLen), textLen);
                    const innerCursor = inlineOffsetToCursor(child.children, approxTextOff, false);
                    return { path: [blockIdx, i, ...innerCursor.path], offsetUtf16: innerCursor.offsetUtf16 };
                }
                const innerCursor = paragraphRenderedOffsetToCursorInline(child.children, offsetInRendered);
                return { path: [blockIdx, i, ...innerCursor.path], offsetUtf16: innerCursor.offsetUtf16 };
            }
            return { path: [blockIdx, i], offsetUtf16: 0 };
        }
        pos += rendered.length;
        textPos += textLen;
    }
    // Past end
    const endC = endCursorForInline(children);
    return { path: [blockIdx, ...endC.path], offsetUtf16: endC.offsetUtf16 };
}

function paragraphRenderedOffsetToCursorInline(nodes, renderedOffset) {
    let pos = 0;
    for (let i = 0; i < nodes.length; i++) {
        const rendered = renderInline([nodes[i]], 'plain-text');
        if (pos + rendered.length > renderedOffset) {
            const off = renderedOffset - pos;
            if (nodes[i].type === 'text' || nodes[i].type === 'inline_code') {
                return { path: [i], offsetUtf16: off };
            }
            if (nodes[i].children) {
                const inner = paragraphRenderedOffsetToCursorInline(nodes[i].children, off);
                return { path: [i, ...inner.path], offsetUtf16: inner.offsetUtf16 };
            }
            return { path: [i], offsetUtf16: 0 };
        }
        pos += rendered.length;
    }
    return endCursorForInline(nodes);
}

/**
 * Convert a rendered offset of a code_block (including fences) to a SourceCursor.
 */
function codeBlockRenderedOffsetToCursor(block, renderedOffset, blockIdx) {
    const lang = block.lang || '';
    const fenceOpenLen = 3 + lang.length + 1; // "```lang\n"
    const valueOffset = Math.max(0, renderedOffset - fenceOpenLen);
    const clampedOffset = Math.min(valueOffset, (block.value || '').length);
    return { path: [blockIdx], offsetUtf16: clampedOffset };
}

/**
 * Convert a rendered plain-text offset of any block to a SourceCursor.
 */
function blockRenderedOffsetToCursor(block, renderedOffset, blockIdx) {
    if (block.type === 'paragraph') {
        return paragraphRenderedOffsetToCursor(block, renderedOffset, blockIdx);
    }
    if (block.type === 'code_block') {
        return codeBlockRenderedOffsetToCursor(block, renderedOffset, blockIdx);
    }
    if (block.type === 'quote') {
        return quoteRenderedOffsetToCursor(block, renderedOffset, blockIdx);
    }
    if (block.type === 'list') {
        return listRenderedOffsetToCursor(block, renderedOffset, blockIdx);
    }
    // For other block types (thematic_break, etc.), first leaf is accurate
    const cursor = findFirstLeafCursorInner(block, []);
    return { path: [blockIdx, ...cursor.path], offsetUtf16: cursor.offsetUtf16 };
}

/**
 * Map a rendered plain-text offset of a quote block to a SourceCursor.
 * Quote rendered as "> "-prefixed lines of child blocks joined by "\n\n".
 */
function quoteRenderedOffsetToCursor(quote, renderedOffset, blockIdx) {
    const childRendered = quote.children.map(c => renderBlocks([c], 'plain-text'));
    const inner = childRendered.join('\n\n');
    // Walk child blocks to find which one contains the offset
    let pos = 0;
    for (let ci = 0; ci < quote.children.length; ci++) {
        const childText = childRendered[ci];
        const childQuotedLines = childText.split('\n').map(l => l === '' ? '>' : '> ' + l);
        const childQuoted = childQuotedLines.join('\n');
        // Separator between child blocks in quoted form: "\n>\n" (from "\n\n" → lines ["", ""] → ">", "")
        const sep = ci > 0 ? '\n>\n' : '';

        if (renderedOffset < pos + sep.length + childQuoted.length || ci === quote.children.length - 1) {
            const offsetInChildQuoted = Math.max(0, renderedOffset - pos - sep.length);
            const innerOffset = quotedOffsetToInnerOffset(childQuoted, offsetInChildQuoted);
            const childBlock = quote.children[ci];
            const innerCursor = blockRenderedOffsetToCursor(childBlock, innerOffset, 0);
            return { path: [blockIdx, ci, ...innerCursor.path.slice(1)], offsetUtf16: innerCursor.offsetUtf16 };
        }
        pos += sep.length + childQuoted.length;
    }
    const endC = findLastLeafCursorInner(quote, []);
    return { path: [blockIdx, ...endC.path], offsetUtf16: endC.offsetUtf16 };
}

/**
 * Convert offset within "> "-prefixed text to offset within inner text.
 */
function quotedOffsetToInnerOffset(quotedText, offsetInQuoted) {
    let innerOff = 0;
    let qOff = 0;
    const lines = quotedText.split('\n');
    for (let li = 0; li < lines.length; li++) {
        if (li > 0) { qOff += 1; innerOff += 1; }
        const line = lines[li];
        const prefixLen = line === '>' ? 1 : line.startsWith('> ') ? 2 : 0;
        if (offsetInQuoted <= qOff + prefixLen) return innerOff;
        if (offsetInQuoted < qOff + line.length) return innerOff + (offsetInQuoted - qOff - prefixLen);
        qOff += line.length;
        innerOff += line.length - prefixLen;
    }
    return innerOff;
}

/**
 * Map a rendered plain-text offset of a list block to a SourceCursor.
 * List items rendered as "marker content" joined by "\n".
 */
function listRenderedOffsetToCursor(list, renderedOffset, blockIdx) {
    let pos = 0;
    for (let ii = 0; ii < list.children.length; ii++) {
        const item = list.children[ii];
        const itemRendered = renderListItemForCursor(item);
        const sep = ii > 0 ? 1 : 0; // "\n" between items

        if (renderedOffset < pos + sep + itemRendered.length || ii === list.children.length - 1) {
            const offsetInItem = Math.max(0, renderedOffset - pos - sep);
            return listItemRenderedOffsetToCursor(item, offsetInItem, blockIdx, ii);
        }
        pos += sep + itemRendered.length;
    }
    const endC = findLastLeafCursorInner(list, []);
    return { path: [blockIdx, ...endC.path], offsetUtf16: endC.offsetUtf16 };
}

function renderListItemForCursor(item) {
    const prefix = item.marker + ' ';
    const indent = '  ';
    const blocks = item.children.map(c => renderBlocks([c], 'plain-text'));
    if (blocks.length === 0) return prefix;
    let result = prefix + blocks[0];
    for (let i = 1; i < blocks.length; i++) {
        result += '\n' + blocks[i].split('\n').map(l => indent + l).join('\n');
    }
    return result;
}

function listItemRenderedOffsetToCursor(item, offsetInItem, blockIdx, itemIdx) {
    const prefix = item.marker + ' ';
    const indent = '  ';

    if (offsetInItem < prefix.length) {
        const cursor = findFirstLeafCursorInner(item, []);
        return { path: [blockIdx, itemIdx, ...cursor.path], offsetUtf16: 0 };
    }

    let pos = prefix.length;
    for (let ci = 0; ci < item.children.length; ci++) {
        const childBlock = item.children[ci];
        const childRendered = renderBlocks([childBlock], 'plain-text');
        const indentedRendered = ci === 0
            ? childRendered
            : childRendered.split('\n').map(l => indent + l).join('\n');
        const sep = ci > 0 ? 1 : 0; // "\n"

        if (offsetInItem < pos + sep + indentedRendered.length || ci === item.children.length - 1) {
            let offsetInChild = Math.max(0, offsetInItem - pos - sep);
            if (ci > 0) {
                offsetInChild = indentedOffsetToInner(indentedRendered, offsetInChild, indent);
            }
            const innerCursor = blockRenderedOffsetToCursor(childBlock, offsetInChild, 0);
            return {
                path: [blockIdx, itemIdx, ci, ...innerCursor.path.slice(1)],
                offsetUtf16: innerCursor.offsetUtf16,
            };
        }
        pos += sep + indentedRendered.length;
    }
    const endC = findLastLeafCursorInner(item, []);
    return { path: [blockIdx, itemIdx, ...endC.path], offsetUtf16: endC.offsetUtf16 };
}

function indentedOffsetToInner(indentedText, offset, indent) {
    const lines = indentedText.split('\n');
    let iOff = 0;
    let innerOff = 0;
    for (let li = 0; li < lines.length; li++) {
        if (li > 0) { iOff += 1; innerOff += 1; }
        const pLen = lines[li].startsWith(indent) ? indent.length : 0;
        if (offset <= iOff + pLen) return innerOff;
        if (offset < iOff + lines[li].length) return innerOff + (offset - iOff - pLen);
        iOff += lines[li].length;
        innerOff += lines[li].length - pLen;
    }
    return innerOff;
}

// =============== source range computation ===============

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
        let sr;
        if (cd.sourceStart) {
            // Use precise cursors from split
            const startPath = [...cd.sourceStart.path];
            startPath[0] += blockOffset;
            let endCursor;
            if (cd.sourceEnd) {
                endCursor = cd.sourceEnd;
            } else {
                endCursor = findLastLeafCursor(ir.children[cd.blockEnd], [cd.blockEnd]);
            }
            const endPath = [...endCursor.path];
            endPath[0] += blockOffset;
            sr = {
                start: { path: startPath, offsetUtf16: cd.sourceStart.offsetUtf16 },
                end: { path: endPath, offsetUtf16: endCursor.offsetUtf16 },
            };
        } else {
            sr = computeSourceRange(ir, cd.blockStart, cd.blockEnd);
            if (blockOffset > 0) {
                sr.start.path[0] += blockOffset;
                sr.end.path[0] += blockOffset;
            }
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
