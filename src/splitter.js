// Splitter: block-level and text-level split logic
// nodejs: v18.16.0
// tab=4spaces

/**
 * Split text using forced-plain-text rules (RFC §12.5).
 * Priority: \n\n → \n → whitespace → forced Unicode-safe.
 * Returns [firstPart, restPart] or null if text fits budget.
 * @param {string} text
 * @param {number} budget
 * @returns {[string, string] | null}
 */
export function splitForcedPlainText(text, budget) {
    const result = splitForcedPlainTextDetailed(text, budget);
    return result ? result.parts : null;
}

/**
 * Detailed forced-plain-text split result with forced-split metadata.
 * @param {string} text
 * @param {number} budget
 * @returns {{ parts: [string, string], hadForcedSplit: boolean } | null}
 */
export function splitForcedPlainTextDetailed(text, budget) {
    if (text.length <= budget) return null;

    const chunk = text.slice(0, budget);

    // 1. \n\n — double newline (block boundary)
    const p1 = chunk.lastIndexOf('\n\n');
    if (p1 > 0) return {
        parts: [text.slice(0, p1), text.slice(p1 + 2)],
        hadForcedSplit: false,
    };

    // 2. \n — single newline
    const p2 = chunk.lastIndexOf('\n');
    if (p2 > 0) return {
        parts: [text.slice(0, p2), text.slice(p2 + 1)],
        hadForcedSplit: false,
    };

    // 3. whitespace (space / tab)
    const p3 = findLastWhitespace(chunk);
    if (p3 > 0) return {
        parts: [text.slice(0, p3), text.slice(p3 + 1)],
        hadForcedSplit: false,
    };

    // 4. forced Unicode-safe split
    return {
        parts: unicodeSafeSplit(text, budget),
        hadForcedSplit: true,
    };
}

/**
 * Split text using paragraph rules (RFC §14.1).
 * Priority: sentence end → ; → , → whitespace → forced Unicode-safe.
 * Returns [firstPart, restPart] or null if text fits budget.
 * @param {string} text
 * @param {number} budget
 * @returns {[string, string] | null}
 */
export function splitByParagraphRules(text, budget) {
    const result = splitByParagraphRulesDetailed(text, budget);
    return result ? result.parts : null;
}

/**
 * Detailed paragraph split result with forced-split metadata.
 * @param {string} text
 * @param {number} budget
 * @returns {{ parts: [string, string], hadForcedSplit: boolean } | null}
 */
export function splitByParagraphRulesDetailed(text, budget) {
    if (text.length <= budget) return null;

    const chunk = text.slice(0, budget);

    // 1. End of sentence: . ! ? followed by space/newline or at end of chunk
    const p1 = findLastSentenceEnd(chunk);
    if (p1 > 0) return {
        parts: [text.slice(0, p1), text.slice(p1).replace(/^\s+/, '')],
        hadForcedSplit: false,
    };

    // 2. Semicolon
    const p2 = chunk.lastIndexOf(';');
    if (p2 > 0) return {
        parts: [text.slice(0, p2 + 1), text.slice(p2 + 1).replace(/^\s+/, '')],
        hadForcedSplit: false,
    };

    // 3. Comma
    const p3 = chunk.lastIndexOf(',');
    if (p3 > 0) return {
        parts: [text.slice(0, p3 + 1), text.slice(p3 + 1).replace(/^\s+/, '')],
        hadForcedSplit: false,
    };

    // 4. Whitespace
    const p4 = findLastWhitespace(chunk);
    if (p4 > 0) return {
        parts: [text.slice(0, p4), text.slice(p4 + 1)],
        hadForcedSplit: false,
    };

    // 5. Forced Unicode-safe split
    return {
        parts: unicodeSafeSplit(text, budget),
        hadForcedSplit: true,
    };
}

/**
 * Forced Unicode-safe split: don't break surrogate pairs.
 * @param {string} text
 * @param {number} maxLen
 * @returns {[string, string]}
 */
export function unicodeSafeSplit(text, maxLen) {
    let splitAt = Math.min(maxLen, text.length);
    if (splitAt > 0 && splitAt < text.length) {
        const prevCode = text.charCodeAt(splitAt - 1);
        // High surrogate (0xD800–0xDBFF) — don't leave it orphaned
        if (prevCode >= 0xD800 && prevCode <= 0xDBFF) {
            splitAt--;
        }
    }
    // If we backed up to 0, take the whole surrogate pair (2 code units)
    if (splitAt <= 0) splitAt = Math.min(2, text.length);
    return [text.slice(0, splitAt), text.slice(splitAt)];
}

/**
 * Compute the maximum prefix length of `text` whose HTML-escaped form
 * fits within `maxRenderedLen` characters.
 * @param {string} text
 * @param {number} maxRenderedLen
 * @returns {number}
 */
export function maxOriginalPrefixForHtml(text, maxRenderedLen) {
    let renderedLen = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const charLen = ch === '&' ? 5  // &amp;
            : ch === '"' ? 6            // &quot;
            : (ch === '<' || ch === '>') ? 4  // &lt; &gt;
            : 1;
        if (renderedLen + charLen > maxRenderedLen) return i;
        renderedLen += charLen;
    }
    return text.length;
}

// --------------- helpers ---------------

/**
 * Find the position after the last sentence-ending punctuation
 * (. ! ?) that is followed by a space, newline, or end-of-string.
 * Returns position after the punctuation, or -1.
 */
function findLastSentenceEnd(text) {
    for (let i = text.length - 1; i >= 0; i--) {
        const ch = text[i];
        if (ch === '.' || ch === '!' || ch === '?') {
            if (i === text.length - 1 || text[i + 1] === ' ' ||
                text[i + 1] === '\n' || text[i + 1] === '\t') {
                return i + 1;
            }
        }
    }
    return -1;
}

/**
 * Find the last space or tab in text.
 * Returns index or -1.
 */
function findLastWhitespace(text) {
    for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] === ' ' || text[i] === '\t') return i;
    }
    return -1;
}
