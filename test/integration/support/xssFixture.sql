-- Installed by test/integration/support/fixture.ts's installXssFixture(),
-- kept in its own file (like snippetsFixture.sql) rather than folded into
-- fixture.sql: this one exists purely to carry a
-- "</script><script>...</script>" payload through a real utPLSQL instance
-- and has no business anywhere near the fixture every other integration
-- test in this suite depends on.
--
-- See test/integration/coverage.test.ts's XSS-passthrough case (issue #13).
-- The package name below is an ordinary Oracle *quoted* identifier -- '<',
-- '>', '/', '.', '_' and '=' are all valid characters inside one (only an
-- embedded double-quote, or an all-blank name, is rejected) -- written
-- directly into this .sql file, never built from a bind variable or
-- string-concatenated at runtime, so this is ordinary DDL, not an injection
-- of any kind. XSS_PAYLOAD in fixture.ts must match the literal text used
-- here (as both the quoted name and the source comment below) so the
-- integration test and this fixture cannot silently drift apart.
CREATE OR REPLACE PACKAGE "UTPLSQLVSC_XSS_PKG</script><script>window.__pwned=1</script>" IS
  -- </script><script>window.__pwned=1</script> (the same payload, this time as a source comment utPLSQL reports verbatim)
  PROCEDURE ping;
END;
/
CREATE OR REPLACE PACKAGE BODY "UTPLSQLVSC_XSS_PKG</script><script>window.__pwned=1</script>" IS
  PROCEDURE ping IS
  BEGIN
    NULL;
  END ping;
END;
/
CREATE OR REPLACE PACKAGE test_xss_pkg IS

  --%suite(utplsql-vsc coverage html-reporter XSS passthrough fixture)

  --%test(exercises the payload-named package so ut_coverage_html_reporter reports it)
  PROCEDURE test_calls_payload_pkg;

END test_xss_pkg;
/
CREATE OR REPLACE PACKAGE BODY test_xss_pkg IS

  PROCEDURE test_calls_payload_pkg IS
  BEGIN
    "UTPLSQLVSC_XSS_PKG</script><script>window.__pwned=1</script>".ping;
    ut.expect(1).to_equal(1);
  END test_calls_payload_pkg;

END test_xss_pkg;
/
