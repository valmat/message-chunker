import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitByParagraphRules } from '../src/splitter.js';

describe('splitter — splitByParagraphRules', () => {
    it('prefers semicolon over later whitespace', () => {
        const text = 'alpha beta; gamma delta epsilon';
        const result = splitByParagraphRules(text, 17);

        assert.deepEqual(result, ['alpha beta;', 'gamma delta epsilon']);
    });

    it('prefers comma over later whitespace', () => {
        const text = 'alpha beta, gamma delta epsilon';
        const result = splitByParagraphRules(text, 17);

        assert.deepEqual(result, ['alpha beta,', 'gamma delta epsilon']);
    });

    it('chooses the rightmost sentence boundary within budget', () => {
        const text = 'One. Two! Three? Four five six';
        const result = splitByParagraphRules(text, 22);

        assert.deepEqual(result, ['One. Two! Three?', 'Four five six']);
    });

    it('chooses the rightmost boundary for equal-priority semicolons', () => {
        const text = 'aa; bb; cc dd';
        const result = splitByParagraphRules(text, 10);

        assert.deepEqual(result, ['aa; bb;', 'cc dd']);
    });

    it('uses forced split only when no softer boundary exists', () => {
        const text = 'abcdefghijk';
        const result = splitByParagraphRules(text, 5);

        assert.deepEqual(result, ['abcde', 'fghijk']);
    });
});
