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
    } = request;

    validateTransportProfile(transport);

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

    // Determine tail start block from the failed chunk's sourceRange
    const failedChunk = previousPlan.chunks[failedChunkIndex];
    const tailBlockIndex = failedChunk.sourceRange.start.path[0];

    // Extract tail blocks
    const tailBlocks = fullIr.children.slice(tailBlockIndex);

    if (tailBlocks.length === 0) {
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
                usedMode: preferredMode === 'plain-text' ? 'plain-text' : 'rich-html',
                hadDegradation: false,
                degradedToPlainText: false,
                splitBlockTypes: [],
            },
        };
    }

    // Build a virtual IR with only the tail blocks
    const tailIr = { type: 'root', children: tailBlocks };

    // Delegate to the core planning engine with blockOffset for correct sourceRanges
    const plan = planFromIr(tailIr, tailBlockIndex, {
        strategy: nextStrategy,
        preferredMode,
        transport,
        markdown,
    });

    return {
        chunks: plan.chunks,
        diagnostics: plan.diagnostics,
    };
}
