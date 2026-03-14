import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    STRATEGY_LADDER,
    nextStrategy,
    isAtLeastAsAggressive,
    validateTransportProfile,
} from '../src/index.js';

describe('types and constants', () => {
    it('STRATEGY_LADDER has 5 strategies in correct order', () => {
        assert.deepEqual(STRATEGY_LADDER, [
            'preserve',
            'split-blocks',
            'split-blocks-soft',
            'plain-text',
            'forced-plain-text',
        ]);
    });

    it('nextStrategy returns next more aggressive strategy', () => {
        assert.equal(nextStrategy('preserve'), 'split-blocks');
        assert.equal(nextStrategy('split-blocks'), 'split-blocks-soft');
        assert.equal(nextStrategy('split-blocks-soft'), 'plain-text');
        assert.equal(nextStrategy('plain-text'), 'forced-plain-text');
        assert.equal(nextStrategy('forced-plain-text'), null);
    });

    it('isAtLeastAsAggressive compares strategies', () => {
        assert.equal(isAtLeastAsAggressive('forced-plain-text', 'preserve'), true);
        assert.equal(isAtLeastAsAggressive('preserve', 'forced-plain-text'), false);
        assert.equal(isAtLeastAsAggressive('split-blocks', 'split-blocks'), true);
    });

    it('validateTransportProfile accepts valid profile', () => {
        const tp = {
            maxTextLength: 4096,
            safeTextBudget: 3600,
            supportsPlainText: true,
            supportsMultipartPlainText: true,
            supportsRichHtml: true,
            countMethod: 'string-length',
        };
        assert.doesNotThrow(() => validateTransportProfile(tp));
    });

    it('validateTransportProfile rejects invalid profiles', () => {
        assert.throws(() => validateTransportProfile(null));
        assert.throws(() => validateTransportProfile({ maxTextLength: 0 }));
        assert.throws(() => validateTransportProfile({
            maxTextLength: 100,
            safeTextBudget: 200,
            supportsPlainText: true,
            supportsMultipartPlainText: true,
            supportsRichHtml: true,
            countMethod: 'string-length',
        }), /must not exceed/);
    });
});
