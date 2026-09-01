import assert from 'node:assert/strict';
import { buildProduceSql, CoverageOptions } from '../../src/db/realtimeDao';

describe('buildProduceSql', () => {
    it('quotes run paths and omits a_tags when none are given', () => {
        const { sql } = buildProduceSql('abc123', ["UT3:test_pkg.test_it's_ok"]);
        assert.match(sql, /a_paths => ut_varchar2_list\('UT3:test_pkg\.test_it''s_ok'\)/);
        assert.doesNotMatch(sql, /a_tags/);
        assert.match(sql, /a_random_test_order => false/);
        assert.match(sql, /a_random_test_order_seed => null/);
    });

    it('binds a_tags as a single comma-joined, quoted varchar2 — not a ut_varchar2_list', () => {
        // ut_runner.run's a_tags parameter is a plain varchar2 (comma-
        // separated, OR-matched), unlike a_paths/a_include_objects/etc.
        const { sql } = buildProduceSql('abc123', ['UT3'], { tags: ['slow', "o'clock"] });
        assert.match(sql, /a_tags => 'slow,o''clock'/);
        assert.doesNotMatch(sql, /a_tags => ut_varchar2_list/);
    });

    it('sets a_random_test_order to true when requested', () => {
        const { sql } = buildProduceSql('abc123', ['UT3'], { randomOrder: true });
        assert.match(sql, /a_random_test_order => true/);
    });

    it('passes a_random_test_order_seed through as a bare numeric literal', () => {
        const { sql } = buildProduceSql('abc123', ['UT3'], { randomOrder: true, seed: 42 });
        assert.match(sql, /a_random_test_order_seed => 42/);
    });

    it('omits coverage arguments entirely when no coverage is requested', () => {
        const { sql, coverageId, htmlId } = buildProduceSql('abc123', ['UT3']);
        assert.doesNotMatch(sql, /a_coverage_schemes/);
        assert.doesNotMatch(sql, /a_include_objects/);
        assert.doesNotMatch(sql, /a_exclude_objects/);
        assert.doesNotMatch(sql, /a_source_file_mappings/);
        assert.equal(coverageId, undefined);
        assert.equal(htmlId, undefined);
    });

    it('includes coverage schemes/include/exclude objects and a fresh coverage reporter id', () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            schemes: ['UT3'],
            includeObjects: ['CALC_PKG'],
            excludeObjects: ['TEST_CALC_PKG'],
            fileMappings: [{ file: 'db/calc_pkg.pkb', owner: 'UT3', name: 'CALC_PKG', type: 'PACKAGE BODY' }]
        };
        const { sql, coverageId } = buildProduceSql('abc123', ['UT3'], { coverage });
        assert.match(sql, /a_coverage_schemes => ut_varchar2_list\('UT3'\)/);
        assert.match(sql, /a_include_objects => ut_varchar2_list\('CALC_PKG'\)/);
        assert.match(sql, /a_exclude_objects => ut_varchar2_list\('TEST_CALC_PKG'\)/);
        assert.ok(coverageId && coverageId.length > 0);
        assert.notEqual(coverageId, 'abc123');
    });

    it('binds the four regex scoping expressions as quoted varchar2 literals, not identifiers', () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            fileMappings: [],
            includeSchemaExpr: 'APP_.*',
            includeObjectExpr: "^(?!.*O'BRIEN).*$",
            excludeSchemaExpr: 'SYS.*',
            excludeObjectExpr: '^UT_.*'
        };
        const { sql } = buildProduceSql('abc123', ['UT3'], { coverage });
        assert.match(sql, /a_include_schema_expr => 'APP_\.\*'/);
        assert.match(sql, /a_include_object_expr => '\^\(\?!\.\*O''BRIEN\)\.\*\$'/);
        assert.match(sql, /a_exclude_schema_expr => 'SYS\.\*'/);
        assert.match(sql, /a_exclude_object_expr => '\^UT_\.\*'/);
    });

    it('omits regex scoping arguments that were not given', () => {
        const coverage: CoverageOptions = { reporter: 'ut_coverage_sonar_reporter', fileMappings: [] };
        const { sql } = buildProduceSql('abc123', ['UT3'], { coverage });
        assert.doesNotMatch(sql, /_expr =>/);
    });

    it('declares a_test_file_mappings from testFileMappings, separate from a_source_file_mappings', () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            fileMappings: [{ file: 'db/calc_pkg.pkb', owner: 'UT3', name: 'CALC_PKG', type: 'PACKAGE BODY' }],
            testFileMappings: [{ file: 'db/test_calc_pkg.pkb', owner: 'UT3', name: 'TEST_CALC_PKG', type: 'PACKAGE BODY' }]
        };
        const { sql } = buildProduceSql('abc123', ['UT3'], { coverage });
        assert.match(sql, /l_test_mappings ut_file_mappings/);
        assert.match(sql, /a_test_file_mappings => l_test_mappings/);
        assert.match(sql, /'db\/test_calc_pkg\.pkb'/);
    });

    it('omits a_test_file_mappings when no test file mappings are given', () => {
        const coverage: CoverageOptions = { reporter: 'ut_coverage_sonar_reporter', fileMappings: [] };
        const { sql } = buildProduceSql('abc123', ['UT3'], { coverage });
        assert.doesNotMatch(sql, /a_test_file_mappings/);
        assert.doesNotMatch(sql, /l_test_mappings/);
    });

    it('adds a second coverage reporter with its own id when additionalReporter differs from reporter', () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            additionalReporter: 'ut_coverage_cobertura_reporter',
            fileMappings: []
        };
        const { sql, coverageId, additionalCoverageId } = buildProduceSql('abc123', ['UT3'], { coverage });
        assert.match(sql, /l_cov_rep2 ut_coverage_cobertura_reporter := ut_coverage_cobertura_reporter\(\)/);
        assert.match(sql, /ut_reporters\(l_rt_rep, l_cov_rep, l_cov_rep2\)/);
        assert.ok(additionalCoverageId && additionalCoverageId.length > 0);
        assert.notEqual(additionalCoverageId, coverageId);
    });

    it('does not add a second reporter when additionalReporter equals reporter', () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_cobertura_reporter',
            additionalReporter: 'ut_coverage_cobertura_reporter',
            fileMappings: []
        };
        const { sql, additionalCoverageId } = buildProduceSql('abc123', ['UT3'], { coverage });
        assert.equal(additionalCoverageId, undefined);
        assert.doesNotMatch(sql, /l_cov_rep2/);
    });

    it('rejects an include/exclude object name that is not a plain identifier', () => {
        const coverage: CoverageOptions = {
            reporter: 'ut_coverage_sonar_reporter',
            includeObjects: ["CALC_PKG'; DROP TABLE t --"],
            fileMappings: []
        };
        assert.throws(() => buildProduceSql('abc123', ['UT3'], { coverage }), /invalid include object/);
    });
});
