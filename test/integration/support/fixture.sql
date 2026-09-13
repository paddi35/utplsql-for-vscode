-- Fixture installed by test/integration/support/fixture.ts before the
-- integration suite runs. Idempotent (CREATE OR REPLACE) so it is safe to
-- run repeatedly against a long-lived schema such as the local docker
-- container's UT3 user. Exercises every run outcome the plan's verification
-- checklist asks for: passed, failed, errored, disabled/skipped, a nested
-- suite context, a tag, and one slow test for the realtime streaming check.

CREATE OR REPLACE PACKAGE calc_pkg IS
  FUNCTION add_numbers(a NUMBER, b NUMBER) RETURN NUMBER;
  FUNCTION divide(a NUMBER, b NUMBER) RETURN NUMBER;
END calc_pkg;
/
CREATE OR REPLACE PACKAGE BODY calc_pkg IS

  FUNCTION add_numbers(a NUMBER, b NUMBER) RETURN NUMBER IS
  BEGIN
    RETURN a + b;
  END add_numbers;

  FUNCTION divide(a NUMBER, b NUMBER) RETURN NUMBER IS
  BEGIN
    RETURN a / b;
  END divide;

END calc_pkg;
/
CREATE OR REPLACE PACKAGE test_calc_pkg IS

  --%suite(utplsql-vsc integration fixture)

  --%test(adds two numbers correctly)
  PROCEDURE test_add;

  --%test(fails on purpose to exercise the failed run state)
  PROCEDURE test_fail_on_purpose;

  --%test(raises an unhandled exception to exercise the errored run state)
  PROCEDURE test_raises_error;

  --%test(disabled test to exercise the skipped run state)
  --%disabled
  PROCEDURE test_disabled_case;

  --%test(sleeps briefly to exercise realtime event streaming)
  --%tags(slow)
  PROCEDURE test_slow;

  --%context(nested)

    --%test(test nested inside a suite context)
    PROCEDURE test_nested;

  --%endcontext

END test_calc_pkg;
/
CREATE OR REPLACE PACKAGE BODY test_calc_pkg IS

  PROCEDURE test_add IS
  BEGIN
    ut.expect(calc_pkg.add_numbers(2, 3)).to_equal(5);
  END test_add;

  PROCEDURE test_fail_on_purpose IS
  BEGIN
    ut.expect(calc_pkg.add_numbers(2, 3)).to_equal(999);
  END test_fail_on_purpose;

  PROCEDURE test_raises_error IS
  BEGIN
    raise_application_error(-20001, 'utplsql-vsc integration fixture: intentional error');
  END test_raises_error;

  PROCEDURE test_disabled_case IS
  BEGIN
    ut.expect(1).to_equal(1);
  END test_disabled_case;

  PROCEDURE test_slow IS
  BEGIN
    dbms_session.sleep(2);
    ut.expect(1).to_equal(1);
  END test_slow;

  PROCEDURE test_nested IS
  BEGIN
    ut.expect(calc_pkg.divide(10, 2)).to_equal(5);
  END test_nested;

END test_calc_pkg;
/
-- A separate --%suitepath-grouped package, for the itemType = UT_LOGICAL_SUITE
-- regression (issue #27, see utplsqlDao.ts's parseItemType). Kept as its own
-- package rather than added to test_calc_pkg above so nothing here changes
-- that package's row count/paths, which other integration tests assert on
-- exactly. As with --%suite, --%suitepath needs a blank line before the
-- first --%test/--%context or the whole package is silently invisible to
-- get_suites_info (see docs/performance.md's Findings) -- kept below.
CREATE OR REPLACE PACKAGE test_suitepath_pkg IS

  --%suite(suitepath grouping fixture)
  --%suitepath(a.b.c)

  --%test(exists only to give the a.b.c suitepath group a real leaf)
  PROCEDURE test_in_group;

END test_suitepath_pkg;
/
CREATE OR REPLACE PACKAGE BODY test_suitepath_pkg IS

  PROCEDURE test_in_group IS
  BEGIN
    ut.expect(1).to_equal(1);
  END test_in_group;

END test_suitepath_pkg;
/
-- Coverage e2e fixture (issue #28, test/e2e/support/coverageCases.ts). Kept as
-- its own package pair rather than reusing calc_pkg/test_calc_pkg above,
-- because those two need to keep their current "no local workspace file"
-- state for as long as they do (the e2e virtual-source coverage case reuses
-- that state directly, and sourceIndexCases.ts controls test_calc_pkg.pkb's
-- local-file lifecycle for its own, unrelated #20/#26 cases). test/e2e/
-- support/copyFixtures.js stages a matching coverage_local_pkg.pkb into the
-- e2e workspace *before* the extension host starts, so SourceIndex maps
-- coverage_local_pkg to a local file from activation onward -- the "local
-- workspace file" shape the coverage e2e cases need. coverage_unmapped_fn is
-- a real dependency that is deliberately not a PACKAGE/PACKAGE BODY (utPLSQL
-- coverage.ts's resolveFileMappings only maps those two object types, see
-- dao.getPackageObjectTypes), so it stays in a_include_objects (it is a real,
-- executed dependency) while never getting a pathToUri entry -- reproducing
-- the reporter's synthetic-fallback-path case parseSonarCoverage's
-- onUnknownPath gate exists for, without depending on which fallback name the
-- reporter happens to invent for it.
CREATE OR REPLACE FUNCTION coverage_unmapped_fn RETURN NUMBER IS
BEGIN
  RETURN 1;
END coverage_unmapped_fn;
/
CREATE OR REPLACE PACKAGE coverage_local_pkg IS
  FUNCTION add_numbers(a NUMBER, b NUMBER) RETURN NUMBER;
  FUNCTION never_called RETURN NUMBER;
END coverage_local_pkg;
/
CREATE OR REPLACE PACKAGE BODY coverage_local_pkg IS

  FUNCTION add_numbers(a NUMBER, b NUMBER) RETURN NUMBER IS
  BEGIN
    RETURN a + b;
  END add_numbers;

  FUNCTION never_called RETURN NUMBER IS
  BEGIN
    RETURN -1;
  END never_called;

END coverage_local_pkg;
/
CREATE OR REPLACE PACKAGE test_coverage_local_pkg IS

  --%suite(utplsql-vsc coverage e2e fixture)

  --%test(adds two numbers, exercising add_numbers and an unmapped standalone-function dependency, but never never_called)
  PROCEDURE test_add_only;

END test_coverage_local_pkg;
/
CREATE OR REPLACE PACKAGE BODY test_coverage_local_pkg IS

  PROCEDURE test_add_only IS
    l_unused NUMBER;
  BEGIN
    l_unused := coverage_unmapped_fn();
    ut.expect(coverage_local_pkg.add_numbers(2, 3)).to_equal(5);
  END test_add_only;

END test_coverage_local_pkg;
/
