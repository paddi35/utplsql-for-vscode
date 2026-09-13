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

    it('leaves a bare escape with no recognized sequence in place (harmless alone), but strips other C0/DEL control characters', () => {
        assert.equal(sanitizeTerminalText(`a${ESC}\x00c\x7Fd`), `a${ESC}cd`);
    });

    it('strips a bare carriage return', () => {
        assert.equal(sanitizeTerminalText('a\rb'), 'ab');
    });
});
