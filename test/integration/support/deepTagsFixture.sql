-- Fixture for issue #18: a --%tags(...) annotation that lives only on a test
-- nested under a --%suitepath group *and* a --%context, so getSuitesInfo +
-- collectTags can be exercised without ever materializing (or even looking
-- at) anything above that depth. Kept in its own package/file rather than
-- added to fixture.sql: that fixture's row counts and exact test names are
-- asserted on exactly elsewhere (discovery.test.ts), and its own tagged test
-- (test_slow, --%tags(slow)) sits at the schema's very first level -- the
-- shallow case the pre-fix MetaStore-based code already happened to get
-- right, not the regression issue #18 is about.
--
-- As with --%suite/--%suitepath elsewhere in this test suite, a blank line
-- is required before the first --%test/--%context or the whole package is
-- silently invisible to get_suites_info (see docs/performance.md's
-- Findings).
CREATE OR REPLACE PACKAGE test_deep_tags_pkg IS

  --%suite(deep tags fixture)
  --%suitepath(deep.tags.group)

  --%context(inner)

    --%test(only reachable by resolving the suitepath group and the context, tagged deep_only)
    --%tags(deep_only)
    PROCEDURE test_deep_tagged;

    --%test(same context, deliberately untagged, so a tag-scoped run can prove it does not execute)
    PROCEDURE test_deep_untagged;

  --%endcontext

END test_deep_tags_pkg;
/
CREATE OR REPLACE PACKAGE BODY test_deep_tags_pkg IS

  PROCEDURE test_deep_tagged IS
  BEGIN
    ut.expect(1).to_equal(1);
  END test_deep_tagged;

  PROCEDURE test_deep_untagged IS
  BEGIN
    ut.expect(1).to_equal(1);
  END test_deep_untagged;

END test_deep_tags_pkg;
/
