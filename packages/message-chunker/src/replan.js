// Replanner: replanTail() — replan undelivered tail after transport reject
// nodejs: v18.16.0
// tab=4spaces

import { normalize } from './normalizer.js';
import { planFromIr } from './planner.js';
import {
    validateTransportProfile,
    STRATEGY_LADDER,
} from './types.js';

/**
 * Replan the undelivered tail of a previously planned message.
 *
 * After the transport rejects chunk `failedChunkIndex`, chunks 0..failedChunkIndex-1
 * are considered delivered. This function replans from the failed chunk's
 * sourceRange.start to the end of the normalized IR.
 *
 * Per RFC §18: re-normalizes the full markdown, extracts the tail blocks
 * starting from the failed chunk's sourceRange, and runs strategy escalation
 * from the given nextStrategy.
 *
 * When the failed chunk is a split-fragment (intra-block split), the function
 * navigates the full cursor path + offsetUtf16 to trim the already-delivered
 * prefix from the first tail block (RFC §18.1, §19.7).
 *
 * @param {import('./types.js').ReplanTailRequest} request
 * @returns {import('./types.js').ReplannedTail}
 */
export function replanTail(request) {
    const {
        markdown,
        previousPlan,
        failedChunkIndex,
        preferredMode,
        nextStrategy,
        transport,
        rejectReason,
    } = request;

    validateTransportProfile(transport);

    const VALID_REJECT_REASONS = ['too-long', 'invalid-markup'];
    if (rejectReason && !VALID_REJECT_REASONS.includes(rejectReason)) {
        throw new Error(`Unknown rejectReason: ${rejectReason}. Valid values: ${VALID_REJECT_REASONS.join(', ')}`);
    }

    if (failedChunkIndex < 0 || failedChunkIndex >= previousPlan.chunks.length) {
        throw new RangeError(
            `failedChunkIndex ${failedChunkIndex} out of range [0, ${previousPlan.chunks.length - 1}]`
        );
    }

    if (!STRATEGY_LADDER.includes(nextStrategy)) {
        throw new Error(`Unknown strategy: ${nextStrategy}`);
    }

    // Re-parse and normalize the full markdown to get fresh IR (RFC §18.3)
    const fullIr = normalize(markdown);

    // Navigate by full cursor path, not just path[0] (RFC §18.1)
    const failedChunk = previousPlan.chunks[failedChunkIndex];
    const startCursor = failedChunk.sourceRange.start;
    const blockIdx = startCursor.path[0];

    if (blockIdx >= fullIr.children.length) {
        return emptyResult(markdown, preferredMode, nextStrategy, transport);
    }

    // Determine if cursor is at the very start of the block
    const block = fullIr.children[blockIdx];
    const atBlockStart = isCursorAtBlockStart(block, startCursor);

    // Build tail IR: trim the first block from cursor position if needed
    let tailIr;
    if (atBlockStart) {
        tailIr = { type: 'root', children: fullIr.children.slice(blockIdx) };
    } else {
        // Intra-block cursor — trim already-delivered prefix from the block
        const subPath = startCursor.path.slice(1);
        const trimmedBlock = trimBlockFromCursor(block, subPath, startCursor.offsetUtf16);
        const restBlocks = fullIr.children.slice(blockIdx + 1);
        const tailChildren = [];
        if (!isEffectivelyEmptyBlock(trimmedBlock)) {
            tailChildren.push(trimmedBlock);
        }
        tailIr = { type: 'root', children: [...tailChildren, ...restBlocks] };
    }

    if (tailIr.children.length === 0) {
        return emptyResult(markdown, preferredMode, nextStrategy, transport);
    }

    // Delegate to the core planning engine with blockOffset for correct sourceRanges
    const plan = planFromIr(tailIr, blockIdx, {
        strategy: nextStrategy,
        preferredMode,
        transport,
        markdown,
    });

    // Translate source ranges for chunks that still refer to the trimmed first block.
    // planFromIr computed these cursors relative to the trimmed structure; convert them
    // back to full-IR coordinates so both start and end remain in the same address space.
    if (!atBlockStart && plan.chunks.length > 0) {
        const trimPath = startCursor.path.slice(1);
        for (const chunk of plan.chunks) {
            if (chunk.sourceRange.start.path[0] === blockIdx) {
                chunk.sourceRange.start = translateCursorFromTrimmedBlock(
                    block,
                    trimPath,
                    startCursor.offsetUtf16,
                    blockIdx,
                    chunk.sourceRange.start,
                );
            }
            if (chunk.sourceRange.end.path[0] === blockIdx) {
                chunk.sourceRange.end = translateCursorFromTrimmedBlock(
                    block,
                    trimPath,
                    startCursor.offsetUtf16,
                    blockIdx,
                    chunk.sourceRange.end,
                );
            }
        }
    }

    return {
        chunks: plan.chunks,
        diagnostics: plan.diagnostics,
    };
}

// --------------- cursor helpers ---------------

/**
 * Check if a cursor points to the very start of a block (first leaf, offset 0).
 */
function isCursorAtBlockStart(block, cursor) {
    if (cursor.offsetUtf16 !== 0) return false;
    const subPath = cursor.path.slice(1);
    const firstLeaf = firstLeafPath(block);
    return pathEquals(subPath, firstLeaf);
}

/**
 * Path to the first leaf node of a block (descending through first children).
 */
function firstLeafPath(node) {
    if (!node.children || node.children.length === 0) return [];
    return [0, ...firstLeafPath(node.children[0])];
}

function pathEquals(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}


function translateCursorFromTrimmedBlock(block, trimPath, trimOffset, blockIdx, cursor) {
    const localPath = cursor.path.slice(1);
    const translatedRelPath = translatePathFromTrimmedNode(block, trimPath, trimOffset, localPath);
    const translatedOffset = pathEquals(translatedRelPath, trimPath)
        ? trimOffset + cursor.offsetUtf16
        : cursor.offsetUtf16;

    return {
        path: [blockIdx, ...translatedRelPath],
        offsetUtf16: translatedOffset,
    };
}

function translatePathFromTrimmedNode(node, trimPath, trimOffset, localPath) {
    if (!node) {
        return [...localPath];
    }

    if (localPath.length === 0) {
        // Cursor points at the current node itself. For leaf blocks such as code_block,
        // this intentionally stays as the block-level path [blockIdx] in full-IR coordinates.
        return [];
    }

    if (!node.children || trimPath.length === 0) {
        return [...localPath];
    }

    const trimmedChildIndex = trimPath[0];
    const localIndex = localPath[0];
    const targetChild = node.children[trimmedChildIndex];
    if (!targetChild) {
        return [...localPath];
    }
    const trimmedTarget = trimBlockFromCursor(targetChild, trimPath.slice(1), trimOffset);

    if (localIndex === 0 && trimmedTarget) {
        return [
            trimmedChildIndex,
            ...translatePathFromTrimmedNode(targetChild, trimPath.slice(1), trimOffset, localPath.slice(1)),
        ];
    }

    const originalIndex = trimmedTarget
        ? trimmedChildIndex + localIndex
        : trimmedChildIndex + localIndex + 1;

    return [originalIndex, ...localPath.slice(1)];
}

// --------------- IR trimming ---------------


function isEffectivelyEmptyBlock(block) {
    if (!block) return true;
    if (Object.prototype.hasOwnProperty.call(block, 'value')) {
        if (block.value === null || block.value === undefined) {
            return true;
        }
        if (typeof block.value === 'string') {
            return block.value.length === 0;
        }
        if (typeof block.value === 'number') {
            return false;
        }
        return true;
    }
    if (block.children) {
        return block.children.every(child => isEffectivelyEmptyBlock(child));
    }
    return false;
}

/**
 * Trim a block from the given cursor position, removing the already-delivered prefix.
 * Recursively descends the path, trimming children and leaf values.
 *
 * @param {Object} block — IR node (paragraph, code_block, quote, list, list_item, etc.)
 * @param {number[]} path — cursor path relative to this block (path[0] is child index)
 * @param {number} offsetUtf16 — character offset within the leaf node
 * @returns {Object} — trimmed copy of the block
 */
function trimBlockFromCursor(block, path, offsetUtf16) {
    if (!block) return null;

    // Path is empty — cursor points at this node directly
    if (path.length === 0) {
        // For code_block: trim value from offset
        if (block.type === 'code_block' && offsetUtf16 > 0) {
            return { ...block, value: (block.value || '').slice(offsetUtf16) };
        }
        // For leaf text/inline_code nodes
        if ((block.type === 'text' || block.type === 'inline_code') && offsetUtf16 > 0) {
            const trimmed = (block.value || '').slice(offsetUtf16);
            return trimmed.length > 0 ? { ...block, value: trimmed } : null;
        }
        return block;
    }

    const childIdx = path[0];
    const restPath = path.slice(1);

    if (!block.children || childIdx >= block.children.length) {
        return block;
    }

    // Recursively trim the child at childIdx
    const child = block.children[childIdx];
    const trimmedChild = trimBlockFromCursor(child, restPath, offsetUtf16);

    // Build new children: trimmed child (if non-null) + all children after childIdx
    const newChildren = [];
    if (trimmedChild) {
        newChildren.push(trimmedChild);
    }
    for (let i = childIdx + 1; i < block.children.length; i++) {
        newChildren.push(block.children[i]);
    }

    return { ...block, children: newChildren };
}

// --------------- empty result helper ---------------

function emptyResult(markdown, preferredMode, nextStrategy, transport) {
    const resolvedMode = preferredMode === 'plain-text' || !transport.supportsRichHtml
        ? 'plain-text'
        : 'rich-html';
    return {
        chunks: [],
        diagnostics: {
            sourceLength: markdown.length,
            plainTextLengthEstimate: 0,
            normalizedBlockCount: 0,
            chunkCount: 0,
            requestedStrategy: nextStrategy,
            usedStrategy: nextStrategy,
            requestedMode: preferredMode,
            usedMode: resolvedMode,
            hadDegradation: false,
            degradedToPlainText: false,
            splitBlockTypes: [],
        },
    };
}
