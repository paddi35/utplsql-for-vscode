/**
 * event.serverOutput/errorStack/warnings (runHandler.ts) and a reporter's own
 * exported text (reporterProfile.ts) are entirely under the control of
 * whoever wrote the PL/SQL under test or the reporter's output — not
 * necessarily the person reading the results on a shared schema. VS Code
 * renders both in an xterm.js-backed view, so unescaped text can carry
 * terminal control sequences: chr(27)||'[2J' clears the pane, chr(27)||'[1A'
 * plus overwriting text rewrites an already-scrolled-past line, letting a
 * failed assertion read as a passing one.
 *
 * Kept in its own module (no `vscode` import) so it stays unit-testable
 * outside the extension host, same reasoning as reporterDao.ts's
 * CancellationSignal doc comment.
 */

// One combined, single-pass pattern -- not three separate .replace() calls --
// because a later independent pass has no way to tell "this ESC was already
// vetted and kept" from "this is a fresh sequence", and would re-match (and
// wrongly strip) the ESC/'[' lead-in of a CSI sequence the first pass just
// decided to preserve.
//
// Alternatives, tried in order at each position:
//   1) CSI: ESC '[' parameter-bytes(0x30-0x3F) intermediate-bytes(0x20-0x2F)
//      final-byte(0x40-0x7E), captured as `finalByte`. SGR (colour), final
//      byte 'm', is the only form callers may legitimately want to keep
//      (utplsql.reporter.colorConsole asks the database for it).
//   2) OSC: ESC ']' ... terminated by BEL or ST (ESC '\'). No SGR-equivalent
//      to preserve.
//   3) Any other single-final-byte escape sequence (cursor save/restore,
//      charset select, reset, ...). `finalByte` stays undefined for both
//      this and the OSC alternative, so the callback strips them.
//   4) A bare ESC that matched none of the above -- see below for why this
//      cannot just be left in place.
const ESCAPE_SEQUENCE_RE = /\x1B\[[0-?]*[ -/]*([@-~])|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[ -/]*[0-~]|\x1B/g;
// Any remaining C0 control character other than tab/newline (DEL, NUL, CR, ...).
// Deliberately excludes ESC (0x1B): that byte is entirely the job of
// ESCAPE_SEQUENCE_RE above, which already decides what to do with every
// well-formed sequence -- this class running over its output would strip the
// ESC out of a just-preserved SGR sequence too, since a plain character class
// can't tell "already vetted and kept" from "still needs stripping". CR is
// included here rather than kept, since the CRLF normalisation callers
// already do re-derives it from '\n' regardless of whether the source used
// bare '\r' or '\r\n'.
//
// An earlier version of ESCAPE_SEQUENCE_RE (alternatives 1-3 only) left a
// bare ESC that matched none of them untouched, on the reasoning that it is
// "harmless alone, since it takes a complete sequence to do anything to a
// terminal". That reasoning does not hold once this ESC's neighbours can
// still change after it is decided to be harmless:
//   - Within one call: a disallowed C0 byte sitting between the ESC and what
//     would otherwise be its final byte (e.g. ESC CR '[2J') makes alternative
//     1-3 fail to match here, so the ESC is left alone by this pass -- and
//     then this same C0 byte is the one DISALLOWED_C0_RE strips next,
//     splicing the ESC directly onto '[2J' and handing the terminal a live
//     clear-screen sequence this function itself just assembled.
//   - Across calls: runHandler.ts sanitizes event.serverOutput, errorStack
//     and each warning separately and appends all of them to the same
//     TestRun output stream. A bare trailing ESC surviving one call and a
//     leading '[2J' surviving the next both individually look "clean" in
//     isolation, but a stateful ANSI parser reassembles them into a working
//     sequence once concatenated.
// Alternative 4 above closes both: every ESC in the input is now consumed by
// this one pass, either as part of a complete (and, for SGR, preserved)
// sequence, or alone -- so no ESC byte can ever reach either danger above.
const DISALLOWED_C0_RE = /[\x00-\x08\x0B-\x1A\x1C-\x1F\x7F]/g;

/**
 * Strips terminal control sequences from database-controlled text before it
 * reaches vscode.TestRun.appendOutput(), keeping SGR (colour) sequences so
 * utplsql.reporter.colorConsole output still renders as intended.
 */
export function sanitizeTerminalText(text: string): string {
    return text
        .replace(ESCAPE_SEQUENCE_RE, (match, finalByte: string | undefined) => (finalByte === 'm' ? match : ''))
        .replace(DISALLOWED_C0_RE, '');
}
