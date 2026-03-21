// Types and constants for MessageChunker
// nodejs: v18.16.0
// tab=4spaces

/**
 * @typedef {'rich-html' | 'plain-text'} RenderMode
 */

/**
 * @typedef {'auto' | 'rich-html' | 'plain-text'} PreferredMode
 */

/**
 * @typedef {'preserve' | 'split-blocks' | 'split-blocks-soft' | 'plain-text' | 'forced-plain-text'} SplitStrategy
 */

/**
 * @typedef {'too-long' | 'invalid-markup'} RejectReason
 */

/**
 * @typedef {'string-length'} CountMethod
 */

// --- IR Node types ---

/**
 * @typedef {'paragraph' | 'heading' | 'list' | 'list_item' | 'quote' | 'code_block' | 'thematic_break'} BlockType
 */

/**
 * @typedef {'text' | 'strong' | 'emphasis' | 'inline_code' | 'link' | 'soft_break' | 'hard_break'} InlineType
 */

/**
 * @typedef {BlockType | InlineType} NodeType
 */

/**
 * @typedef {Object} IRNode
 * @property {NodeType} type
 * @property {IRNode[]} [children]
 * @property {string} [value]        - text content for text, inline_code, code_block
 * @property {number} [level]        - heading level (1-6)
 * @property {boolean} [ordered]     - for list nodes
 * @property {number} [start]        - start number for ordered lists
 * @property {string} [lang]         - language info for code_block
 * @property {string} [href]         - URL for link nodes
 * @property {string} [marker]       - list item marker (-, *, 1., 2., etc.)
 * @property {{ hadUnsupportedDegradation?: boolean }} [meta]
 */

// --- Transport Profile ---

/**
 * @typedef {Object} TransportProfile
 * @property {number} maxTextLength
 * @property {number} safeTextBudget
 * @property {true} supportsPlainText
 * @property {true} supportsMultipartPlainText
 * @property {boolean} supportsRichHtml
 * @property {CountMethod} countMethod
 */

// --- Source addressing ---

/**
 * @typedef {Object} SourceCursor
 * @property {number[]} path         - path from IR root to leaf node
 * @property {number} offsetUtf16    - offset in UTF-16 code units
 */

/**
 * @typedef {Object} SourceRange
 * @property {SourceCursor} start
 * @property {SourceCursor} end
 */

// --- Plan request ---

/**
 * @typedef {Object} PlanRequest
 * @property {string} markdown
 * @property {PreferredMode} preferredMode
 * @property {SplitStrategy} strategy
 * @property {TransportProfile} transport
 */

// --- Chunk ---

/**
 * @typedef {Object} PlannedChunk
 * @property {number} index
 * @property {number} total
 * @property {RenderMode} mode
 * @property {string} content
 * @property {number} estimatedLength
 * @property {SourceRange} sourceRange
 */

// --- Diagnostics ---

/**
 * @typedef {Object} PlanDiagnostics
 * @property {number} sourceLength
 * @property {number} plainTextLengthEstimate
 * @property {number} normalizedBlockCount
 * @property {number} chunkCount
 * @property {SplitStrategy} requestedStrategy
 * @property {SplitStrategy} usedStrategy
 * @property {PreferredMode} requestedMode
 * @property {RenderMode} usedMode
 * @property {boolean} hadDegradation
 * @property {boolean} degradedToPlainText
 * @property {boolean} hadForcedSplit
 * @property {string[]} splitBlockTypes
 */

// --- Delivery Plan ---

/**
 * @typedef {Object} DeliveryPlan
 * @property {PlannedChunk[]} chunks
 * @property {PlanDiagnostics} diagnostics
 */

// --- Replan request ---

/**
 * @typedef {Object} ReplanTailRequest
 * @property {string} markdown
 * @property {DeliveryPlan} previousPlan
 * @property {number} failedChunkIndex
 * @property {PreferredMode} preferredMode
 * @property {SplitStrategy} nextStrategy
 * @property {TransportProfile} transport
 * @property {RejectReason} rejectReason
 */

/**
 * @typedef {Object} ReplannedTail
 * @property {PlannedChunk[]} chunks
 * @property {PlanDiagnostics} diagnostics
 */

// --- Constants ---

/** Strategy escalation ladder (from least to most aggressive) */
export const STRATEGY_LADDER = [
    'preserve',
    'split-blocks',
    'split-blocks-soft',
    'plain-text',
    'forced-plain-text',
];

/**
 * Returns the next more aggressive strategy, or null if already at the most aggressive.
 * @param {SplitStrategy} strategy
 * @returns {SplitStrategy | null}
 */
export function nextStrategy(strategy) {
    const idx = STRATEGY_LADDER.indexOf(strategy);
    if (idx === -1 || idx === STRATEGY_LADDER.length - 1) return null;
    return STRATEGY_LADDER[idx + 1];
}

/**
 * Returns true if `a` is at least as aggressive as `b`.
 * @param {SplitStrategy} a
 * @param {SplitStrategy} b
 * @returns {boolean}
 */
export function isAtLeastAsAggressive(a, b) {
    return STRATEGY_LADDER.indexOf(a) >= STRATEGY_LADDER.indexOf(b);
}

/**
 * Validates a TransportProfile, throws on invalid.
 * @param {TransportProfile} tp
 */
export function validateTransportProfile(tp) {
    if (!tp || typeof tp !== 'object') {
        throw new Error('TransportProfile must be an object');
    }
    if (typeof tp.maxTextLength !== 'number' || tp.maxTextLength <= 0) {
        throw new Error('TransportProfile.maxTextLength must be a positive number');
    }
    if (typeof tp.safeTextBudget !== 'number' || tp.safeTextBudget <= 0) {
        throw new Error('TransportProfile.safeTextBudget must be a positive number');
    }
    if (tp.safeTextBudget < 200) {
        throw new Error('TransportProfile.safeTextBudget must be at least 200 (RFC v1 minimum)');
    }
    if (tp.safeTextBudget > tp.maxTextLength) {
        throw new Error('TransportProfile.safeTextBudget must not exceed maxTextLength');
    }
    if (tp.supportsPlainText !== true) {
        throw new Error('TransportProfile.supportsPlainText must be true');
    }
    if (tp.supportsMultipartPlainText !== true) {
        throw new Error('TransportProfile.supportsMultipartPlainText must be true');
    }
    if (typeof tp.supportsRichHtml !== 'boolean') {
        throw new Error('TransportProfile.supportsRichHtml must be a boolean');
    }
    if (tp.countMethod !== 'string-length') {
        throw new Error("TransportProfile.countMethod must be 'string-length'");
    }
}
