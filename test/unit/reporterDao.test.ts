import assert from 'node:assert/strict';
import { buildRunWithReporterSql } from '../../src/db/reporterDao';

describe('buildRunWithReporterSql', () => {
    it('quotes paths and omits a_color_console/a_client_character_set by default', () => {
        const sql = buildRunWithReporterSql('abc123', 'ut_documentation_reporter', ['UT3:test_pkg']);
        assert.match(sql, /a_paths => ut_varchar2_list\('UT3:test_pkg'\)/);
        assert.doesNotMatch(sql, /a_color_console/);
        assert.doesNotMatch(sql, /a_client_character_set/);
    });

    it('adds a_color_console => true when requested', () => {
        const sql = buildRunWithReporterSql('abc123', 'ut_documentation_reporter', ['UT3'], { colorConsole: true });
        assert.match(sql, /a_color_console => true/);
    });

    it('quotes a_client_character_set as a varchar2 literal, escaping embedded quotes', () => {
        const sql = buildRunWithReporterSql('abc123', 'ut_documentation_reporter', ['UT3'], { clientCharacterSet: "AL32UTF8'; --" });
        assert.match(sql, /a_client_character_set => 'AL32UTF8''; --'/);
    });

    it('uses the given reporter type for both the declaration and constructor call', () => {
        const sql = buildRunWithReporterSql('abc123', 'ut_junit_reporter', ['UT3']);
        assert.match(sql, /l_reporter ut_junit_reporter := ut_junit_reporter\(\)/);
    });
});
