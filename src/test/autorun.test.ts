// This file unit-tests the auto-run output parser in src/autorun.ts.
// - Verifies the "<COLOR>|<RESULT_MESSAGE>|<POPUP_MESSAGE>" contract:
//   accepted colors and case handling, empty message fields, whitespace
//   trimming, last-line-wins when scripts log noise before their status
//   line, and rejection when no line matches.

import * as assert from 'assert';
import { parseAutoRunOutput } from '../autorun';

suite('parseAutoRunOutput', () => {
    test('parses a full red status line', () => {
        assert.deepStrictEqual(
            parseAutoRunOutput('red|In peak, 1 h 30 min left|Costs are higher now'),
            { status: 'red', message: 'In peak, 1 h 30 min left', popupMessage: 'Costs are higher now' },
        );
    });

    test('accepts green and yellow in any case', () => {
        assert.strictEqual(parseAutoRunOutput('GREEN|ok|')?.status, 'green');
        assert.strictEqual(parseAutoRunOutput(' Yellow |warn|')?.status, 'yellow');
    });

    test('allows empty result and popup messages', () => {
        assert.deepStrictEqual(
            parseAutoRunOutput('green|Next peak in 1 h|'),
            { status: 'green', message: 'Next peak in 1 h', popupMessage: '' },
        );
        assert.deepStrictEqual(
            parseAutoRunOutput('green||'),
            { status: 'green', message: '', popupMessage: '' },
        );
    });

    test('trims whitespace around every field', () => {
        assert.deepStrictEqual(
            parseAutoRunOutput('  red | message | popup '),
            { status: 'red', message: 'message', popupMessage: 'popup' },
        );
    });

    test('takes the last valid line when other output precedes it', () => {
        const stdout = 'log: starting check\nprobe 1 of 2\ngreen|First|\n(2 probes done)\nred|Second|';
        assert.deepStrictEqual(
            parseAutoRunOutput(stdout),
            { status: 'red', message: 'Second', popupMessage: '' },
        );
    });

    test('returns undefined when no line matches the contract', () => {
        assert.strictEqual(parseAutoRunOutput(''), undefined);
        assert.strictEqual(parseAutoRunOutput('all good!\nstatus: GREEN'), undefined);
        assert.strictEqual(parseAutoRunOutput('blu|not a status|'), undefined);
    });
});
