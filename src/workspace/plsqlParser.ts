/**
 * Port of UtplsqlParser's two regex scanners. Runs on plain text so it can be
 * used both for open documents and for files read from disk during a
 * workspace scan.
 */

const OBJECT_HEADER_RE =
    /(\s*)(create(\s+or\s+replace)?\s+(package|type|function|procedure)\s+(body\s+)?)([^\s]+)(\s+)/gi;
const PROCEDURE_RE = /(\s*)(procedure)(\s+)([^\s(;]+)/gi;

export interface ParsedPosition {
    offset: number;
    line: number;
    character: number;
}

export interface ParsedIndexEntry {
    /** PACKAGE or PACKAGE.PROCEDURE, always upper-cased. */
    key: string;
    isBody: boolean;
    start: ParsedPosition;
    end: ParsedPosition;
}

/**
 * Blanks out -- line comments, /* block comments and '...' string literals
 * while preserving length and newlines, so offsets stay valid against the
 * original text.
 */
export function stripCommentsAndStrings(text: string): string {
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        const c2 = i + 1 < n ? text[i + 1] : '';
        if (c === '-' && c2 === '-') {
            let j = i;
            while (j < n && text[j] !== '\n') {
                out += ' ';
                j++;
            }
            i = j;
        } else if (c === '/' && c2 === '*') {
            let j = i;
            while (j < n && !(text[j] === '*' && j + 1 < n && text[j + 1] === '/')) {
                out += text[j] === '\n' ? '\n' : ' ';
                j++;
            }
            if (j < n) {
                out += '  ';
                j += 2;
            }
            i = j;
        } else if (c === "'") {
            out += ' ';
            let j = i + 1;
            while (j < n) {
                if (text[j] === "'" && j + 1 < n && text[j + 1] === "'") {
                    out += '  ';
                    j += 2;
                    continue;
                }
                if (text[j] === "'") {
                    out += ' ';
                    j++;
                    break;
                }
                out += text[j] === '\n' ? '\n' : ' ';
                j++;
            }
            i = j;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

function buildLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            starts.push(i + 1);
        }
    }
    return starts;
}

function offsetToPosition(lineStarts: number[], offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (lineStarts[mid] <= offset) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return { line: lo, character: offset - lineStarts[lo] };
}

interface RawMatch {
    name: string;
    isBody: boolean;
    isPackageOrType: boolean;
    matchStart: number;
    nameStart: number;
    nameEnd: number;
}

function findObjectHeaders(clean: string): RawMatch[] {
    const matches: RawMatch[] = [];
    OBJECT_HEADER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OBJECT_HEADER_RE.exec(clean))) {
        const objectType = m[4].toLowerCase();
        const isBody = !!m[5];
        const name = m[6];
        const nameStart = m.index + m[0].length - m[7].length - name.length;
        matches.push({
            name,
            isBody,
            isPackageOrType: objectType === 'package' || objectType === 'type',
            matchStart: m.index,
            nameStart,
            nameEnd: nameStart + name.length
        });
    }
    return matches;
}

function findProcedures(clean: string, from: number, to: number): RawMatch[] {
    const matches: RawMatch[] = [];
    PROCEDURE_RE.lastIndex = from;
    let m: RegExpExecArray | null;
    while ((m = PROCEDURE_RE.exec(clean)) && m.index < to) {
        const name = m[4];
        const nameStart = m.index + m[0].length - name.length;
        matches.push({
            name,
            isBody: true,
            isPackageOrType: false,
            matchStart: m.index,
            nameStart,
            nameEnd: nameStart + name.length
        });
    }
    return matches;
}

/** Result: PACKAGE[.PROCEDURE] -> location, case-insensitive keys (upper-cased). */
export function parseSource(text: string): ParsedIndexEntry[] {
    const clean = stripCommentsAndStrings(text);
    const lineStarts = buildLineStarts(text);
    const headers = findObjectHeaders(clean);
    const entries: ParsedIndexEntry[] = [];

    const toEntry = (key: string, isBody: boolean, start: number, end: number): ParsedIndexEntry => {
        const s = offsetToPosition(lineStarts, start);
        const e = offsetToPosition(lineStarts, end);
        return {
            key: key.toUpperCase(),
            isBody,
            start: { offset: start, ...s },
            end: { offset: end, ...e }
        };
    };

    for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        const nextStart = i + 1 < headers.length ? headers[i + 1].matchStart : clean.length;
        entries.push(toEntry(header.name, header.isBody, header.nameStart, header.nameEnd));

        if (header.isPackageOrType && header.isBody) {
            const procMatches = findProcedures(clean, header.nameEnd, nextStart);
            for (const proc of procMatches) {
                entries.push(toEntry(`${header.name}.${proc.name}`, true, proc.nameStart, proc.nameEnd));
            }
        }
    }
    return entries;
}

/**
 * Port of UtplsqlParser.getPathAt: the entry whose declaration precedes the
 * cursor offset most closely — a procedure inside a package body wins over
 * the enclosing package itself when the cursor sits after it.
 */
export function findEntryAtOffset(entries: ParsedIndexEntry[], offset: number): ParsedIndexEntry | undefined {
    let best: ParsedIndexEntry | undefined;
    for (const entry of entries) {
        if (entry.start.offset <= offset && (!best || entry.start.offset > best.start.offset)) {
            best = entry;
        }
    }
    return best;
}
