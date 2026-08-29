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
