-- Compiles a literal instantiation of every non-trivial snippet body from
-- snippets/utplsql.code-snippets against a real utPLSQL schema — the
-- annotation syntax and matcher/API names were verified by reading the
-- installed utPLSQL 3.2.3 source and userguide, but the a_tags bug (see
-- runOptions.test.ts) showed that reading the API is not the same as
-- compiling and running it, so every snippet gets one real compile+run here.

CREATE OR REPLACE PACKAGE test_snippets_pkg IS

  --%suite(Snippet verification fixture)
  --%tags(snippet_check)

  --%beforeall
  PROCEDURE setup_all;

  --%test(to_be_between/to_be_greater_than/to_be_less_than compile and pass)
  PROCEDURE test_numeric_matchers;

  --%test(to_match and to_be_like compile and pass)
  PROCEDURE test_string_matchers;

  --%test(cursor to_contain/to_have_count compile and pass)
  PROCEDURE test_cursor_matchers;

  --%test(cursor to_equal with include/unordered chain compiles and passes)
  PROCEDURE test_cursor_equal_modifiers;

  --%test(json to_equal compiles and passes)
  PROCEDURE test_json_matcher;

  --%test(set_nls/reset_nls around a DATE cursor comparison compiles and passes)
  PROCEDURE test_nls_cursor;

  --%test(ut.fail compiles and fails the test as documented)
  PROCEDURE test_fail;

  --%test(percent-throws with a predefined Oracle exception)
  --%throws(no_data_found)
  PROCEDURE test_throws;

  --%test(percent-beforetest/aftertest naming a setup/teardown procedure)
  --%beforetest(test_snippets_pkg.before_one_test)
  --%aftertest(test_snippets_pkg.after_one_test)
  PROCEDURE test_before_after_test;

  --%context(named context)
  --%name(demo_context)

    --%test(context nested test still runs)
    PROCEDURE test_in_context;

  --%endcontext

  PROCEDURE before_one_test;
  PROCEDURE after_one_test;

END test_snippets_pkg;
/
CREATE OR REPLACE PACKAGE BODY test_snippets_pkg IS

  g_before_test_ran BOOLEAN := FALSE;
  g_after_test_ran BOOLEAN := FALSE;

  PROCEDURE setup_all IS
  BEGIN
    NULL;
  END setup_all;

  PROCEDURE test_numeric_matchers IS
  BEGIN
    ut.expect(5).to_be_between(1, 10);
    ut.expect(5).to_be_greater_than(1);
    ut.expect(5).to_be_greater_or_equal(5);
    ut.expect(5).to_be_less_than(10);
    ut.expect(5).to_be_less_or_equal(5);
  END test_numeric_matchers;

  PROCEDURE test_string_matchers IS
  BEGIN
    ut.expect('hello world').to_match('^hello');
    ut.expect('hello world').to_be_like('hello%');
  END test_string_matchers;

  PROCEDURE test_cursor_matchers IS
    l_actual SYS_REFCURSOR;
    l_expected_subset SYS_REFCURSOR;
  BEGIN
    OPEN l_actual FOR SELECT 1 AS id FROM dual UNION ALL SELECT 2 FROM dual;
    ut.expect(l_actual).to_have_count(2);

    -- to_contain(a_expected sys_refcursor): actual must contain every row of
    -- expected. The anydata overload asserts one ROW (an object type
    -- matching the cursor's row shape) is present, not a bare scalar —
    -- anydata.convertnumber(1) fails deep inside ut_data_value_anydata/
    -- dbms_assert with ORA-44004 ("invalid qualified SQL name") instead,
    -- confirmed against a live utPLSQL 3.2.3 instance.
    OPEN l_actual FOR SELECT 1 AS id FROM dual UNION ALL SELECT 2 FROM dual;
    OPEN l_expected_subset FOR SELECT 1 AS id FROM dual;
    ut.expect(l_actual).to_contain(l_expected_subset);
  END test_cursor_matchers;

  PROCEDURE test_cursor_equal_modifiers IS
    l_actual SYS_REFCURSOR;
    l_expected SYS_REFCURSOR;
  BEGIN
    OPEN l_actual FOR SELECT 1 AS id, 'x' AS extra_col FROM dual;
    OPEN l_expected FOR SELECT 1 AS id FROM dual;
    -- Column names passed to include/exclude/join_by are case-sensitive
    -- (confirmed against a live utPLSQL 3.2.3 instance via the installed
    -- advanced_data_comparison userguide page) — an unquoted column alias
    -- like "extra_col" resolves to EXTRA_COL, and passing the lowercase
    -- spelling here silently fails to exclude it.
    ut.expect(l_actual).to_equal(l_expected).exclude('EXTRA_COL').unordered;
  END test_cursor_equal_modifiers;

  PROCEDURE test_json_matcher IS
  BEGIN
    ut.expect(json_element_t.parse('{"a":1}')).to_equal(json_element_t.parse('{"a":1}'));
  END test_json_matcher;

  PROCEDURE test_nls_cursor IS
    l_actual SYS_REFCURSOR;
    l_expected SYS_REFCURSOR;
  BEGIN
    -- set_nls must stay active through OPEN *and* the comparison itself:
    -- ut.pks's own doc comment says reset_nls only needs to run "after
    -- refcursor is open", but confirmed against a live utPLSQL 3.2.3
    -- instance, calling reset_nls before to_equal raises ORA-01861 out of
    -- ut_data_value_refcursor — the comparison re-derives the DATE format
    -- from the session's *current* NLS setting at compare time, not from
    -- whatever was active when the cursor was opened.
    ut.set_nls;
    OPEN l_actual FOR SELECT DATE '2024-01-15' AS d FROM dual;
    OPEN l_expected FOR SELECT DATE '2024-01-15' AS d FROM dual;
    ut.expect(l_actual).to_equal(l_expected);
    ut.reset_nls;
  END test_nls_cursor;

  PROCEDURE test_fail IS
  BEGIN
    ut.fail('deliberate failure to verify ut.fail compiles and behaves as documented');
  END test_fail;

  PROCEDURE test_throws IS
  BEGIN
    RAISE no_data_found;
  END test_throws;

  PROCEDURE before_one_test IS
  BEGIN
    g_before_test_ran := TRUE;
  END before_one_test;

  PROCEDURE after_one_test IS
  BEGIN
    g_after_test_ran := TRUE;
  END after_one_test;

  PROCEDURE test_before_after_test IS
  BEGIN
    ut.expect(g_before_test_ran).to_be_true;
  END test_before_after_test;

  PROCEDURE test_in_context IS
  BEGIN
    ut.expect(1).to_equal(1);
  END test_in_context;

END test_snippets_pkg;
/
