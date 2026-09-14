import assert from 'node:assert/strict';
import { sanitizeTerminalText } from '../../src/testing/terminalSanitize';

const ESC = '\x1B';

describe('sanitizeTerminalText', () => {
    it('leaves plain text unchanged', () => {
        assert.equal(sanitizeTerminalText('PASS: test_it_works'), 'PASS: test_it_works');
    });

    it('leaves tab and newline untouched', () => {
        assert.equal(sanitizeTerminalText('a\tb\nc'), 'a\tb\nc');
    });

    it('strips a clear-screen CSI sequence (the pane-clearing attack from the security review)', () => {
        assert.equal(sanitizeTerminalText(`before${ESC}[2Jafter`), 'beforeafter');
    });

    it('strips a cursor-up CSI sequence (the line-rewriting attack from the security review)', () => {
        assert.equal(sanitizeTerminalText(`before${ESC}[1Aafter`), 'beforeafter');
    });

    it('keeps an SGR (colour) CSI sequence so colorConsole output still renders', () => {
        const input = `${ESC}[32mPASS${ESC}[0m`;
        assert.equal(sanitizeTerminalText(input), input);
    });

    it('strips an OSC sequence terminated by BEL', () => {
        assert.equal(sanitizeTerminalText(`${ESC}]0;evil title\x07visible`), 'visible');
    });

    it('strips an OSC sequence terminated by ST (ESC \\\\)', () => {
        assert.equal(sanitizeTerminalText(`${ESC}]0;evil title${ESC}\\visible`), 'visible');
    });

    it('strips a generic single-final-byte escape sequence (e.g. cursor save/restore)', () => {
        assert.equal(sanitizeTerminalText(`before${ESC}7after`), 'beforeafter');
    });

    it('strips a bare escape with no recognized sequence, along with the other C0/DEL control characters around it', () => {
        assert.equal(sanitizeTerminalText(`a${ESC}\x00c\x7Fd`), 'acd');
    });

    it('strips a bare carriage return', () => {
        assert.equal(sanitizeTerminalText('a\rb'), 'ab');
    });

    it('does not let a disallowed C0 byte between ESC and its final byte splice them into a live sequence once that byte is stripped', () => {
        // Regression case: an earlier version left the ESC in place here
        // (none of the CSI/OSC/generic alternatives match ESC+CR), then a
        // second, independent pass stripped the CR, leaving ESC directly
        // adjacent to '[2J' -- a real clear-screen sequence neither the
        // original input nor either pass alone ever produced on its own.
        assert.equal(sanitizeTerminalText(`before${ESC}\r[2Jafter`), 'before[2Jafter');
    });

    it('strips a bare trailing ESC so concatenating two independently-sanitized chunks cannot reconstruct a sequence', () => {
        // Regression case: runHandler.ts sanitizes serverOutput, errorStack
        // and each warning separately and appends them to the same output
        // stream. A trailing ESC surviving one call plus a leading '[2J'
        // surviving the next both look clean on their own, but a stateful
        // ANSI parser reassembles them into a live sequence once concatenated.
        const producer = sanitizeTerminalText(`before${ESC}`);
        const consumer = sanitizeTerminalText('[2Jafter');
        assert.equal(producer + consumer, 'before[2Jafter');
    });
});
