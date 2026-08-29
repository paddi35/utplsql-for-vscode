import assert from 'node:assert/strict';
import { findEntryAtOffset, parseSource, stripCommentsAndStrings } from '../../src/workspace/plsqlParser';

describe('plsqlParser', () => {
    it('strips line comments, block comments and string literals while preserving length', () => {
        const text = "SELECT 'a''b' FROM dual; -- comment\n/* block\ncomment */ x";
        const stripped = stripCommentsAndStrings(text);
        assert.equal(stripped.length, text.length);
        assert.ok(!stripped.includes('comment'));
        assert.ok(!stripped.includes("a''b"));
        assert.ok(stripped.includes('SELECT'));
        assert.ok(stripped.includes('\n'));
    });

    it('indexes a package spec and body with CREATE OR REPLACE', () => {
        const text = `create or replace package pkg_x is
  procedure p1;
end pkg_x;
/
create or replace package body pkg_x is
  procedure p1 is
  begin
    null;
  end p1;
end pkg_x;
/
`;
        const entries = parseSource(text);
        const keys = entries.map((e) => e.key);
        assert.ok(keys.includes('PKG_X'));
        assert.ok(keys.includes('PKG_X.P1'));
        const body = entries.find((e) => e.key === 'PKG_X' && e.isBody);
        assert.ok(body);
        const proc = entries.find((e) => e.key === 'PKG_X.P1');
        assert.ok(proc?.isBody);
    });

    it('is case-insensitive on the object keyword and body keyword', () => {
        const text = 'CREATE OR REPLACE PACKAGE BODY Pkg_Y IS\n  PROCEDURE Do_Thing;\nEND Pkg_Y;\n/\n';
        const entries = parseSource(text);
        assert.ok(entries.some((e) => e.key === 'PKG_Y'));
        assert.ok(entries.some((e) => e.key === 'PKG_Y.DO_THING'));
    });

    it('does not pick up "procedure" mentioned inside a string or comment', () => {
        const text = "create or replace package body pkg_z is\n  -- procedure fake_one;\n  x varchar2(30) := 'procedure fake_two';\n  procedure real_one;\nend pkg_z;\n/\n";
        const entries = parseSource(text);
        const keys = entries.map((e) => e.key);
        assert.ok(keys.includes('PKG_Z.REAL_ONE'));
        assert.ok(!keys.includes('PKG_Z.FAKE_ONE'));
        assert.ok(!keys.includes('PKG_Z.FAKE_TWO'));
    });

    it('findEntryAtOffset returns the declaration closest before the cursor', () => {
        const text = 'create or replace package body pkg_x is\n  procedure p1;\n  procedure p2;\nend pkg_x;\n/\n';
        const entries = parseSource(text);
        const offsetOfP2Body = text.indexOf('procedure p2') + 'procedure p'.length;
        const entry = findEntryAtOffset(entries, offsetOfP2Body);
        assert.equal(entry?.key, 'PKG_X.P2');
    });
});
