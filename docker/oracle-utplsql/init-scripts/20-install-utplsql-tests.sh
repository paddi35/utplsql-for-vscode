#!/bin/bash
# Installiert die utPLSQL-Test-Suite (test/) in die Ziel-PDB.
#
# Legt die von den Tests benoetigten Schemas an (UT3_TESTER, UT3_USER,
# UT3_TESTER_HELPER sowie ein paar Hilfs-User fuer Privilegien-Tests) und
# installiert anschliessend die Testpakete daraus, analog zu
# utPLSQL/test/install_tests.sh.
#
# ACHTUNG: UT3_TESTER_HELPER erhaelt dafuer sehr weitreichende Rechte
# (u.a. GRANT ANY TABLE/PROCEDURE/TYPE, CREATE PUBLIC DATABASE LINK,
# CREATE JOB), da damit utPLSQL's eigene Framework-Interna getestet werden.
# Das ist fuer eine lokale Dev-/Test-Datenbank gedacht, NICHT fuer Produktiv-
# Umgebungen. Mit UTPLSQL_INSTALL_TESTS=false lässt sich dieser Schritt
# komplett abschalten.
#
# Wird von container-entrypoint.sh automatisch beim allerersten Start
# ausgefuehrt (nach 10-install-utplsql.sh).
set -Eeuo pipefail

if [ "${UTPLSQL_INSTALL_TESTS:-true}" != "true" ]; then
  echo "CONTAINER: UTPLSQL_INSTALL_TESTS=false - skipping utPLSQL test suite installation."
  exit 0
fi

TARGET_PDB="${UTPLSQL_TARGET_PDB:-FREEPDB1}"
UT3_TABLESPACE="${UTPLSQL_TABLESPACE:-USERS}"
# Bewusst NICHT auf das hart codierte "ut3" aus dem Original-CI-Skript
# gemappt: das waere ein oeffentlich bekanntes Passwort fuer hoch
# privilegierte Test-Schemas. Default: gleiches Passwort wie das Haupt-Schema.
TEST_PASSWORD="${UTPLSQL_TEST_SCHEMA_PASSWORD:-${UTPLSQL_SCHEMA_PASSWORD:-${ORACLE_PASSWORD}}}"

# Die Testpakete (test/ut3_tester_helper/*.pkb etc.) referenzieren das zu
# testende Framework-Schema hart codiert als "UT3_DEVELOP" (siehe z.B.
# test/ut3_tester_helper/coverage_helper.pkb) - unabhaengig davon, wie das
# fuer den eigenen Gebrauch installierte Schema (UTPLSQL_SCHEMA, Default UT3)
# heisst. Daher installieren wir hier zusaetzlich eine eigene, dedizierte
# Kopie des Frameworks unter dem fest verdrahteten Namen UT3_DEVELOP - nur
# fuer die Test-Suite, die normale UT3-Installation bleibt unangetastet.
UT3_DEVELOP_SCHEMA="UT3_DEVELOP"

echo "CONTAINER: Installing utPLSQL framework as ${UT3_DEVELOP_SCHEMA} (required by the test suite) into PDB '${TARGET_PDB}'..."

cd /opt/utplsql/source

sqlplus -s / as sysdba <<SQL
WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET CONTAINER=${TARGET_PDB};
alter session set plsql_optimize_level=0;
@install_headless.sql ${UT3_DEVELOP_SCHEMA} ${TEST_PASSWORD} ${UT3_TABLESPACE}
SQL

sqlplus -s / as sysdba <<SQL
WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET CONTAINER=${TARGET_PDB};
alter user ${UT3_DEVELOP_SCHEMA} enable editions;
EXIT
SQL

echo "CONTAINER: DONE: Installing utPLSQL framework as ${UT3_DEVELOP_SCHEMA}."

echo "CONTAINER: Creating utPLSQL test users in PDB '${TARGET_PDB}'..."

sqlplus -s / as sysdba <<SQL
WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET CONTAINER=${TARGET_PDB};

PROMPT Adding back create-trigger privilege to ${UT3_DEVELOP_SCHEMA} for testing
grant administer database trigger to ${UT3_DEVELOP_SCHEMA};

PROMPT Creating UT3_TESTER - Power-user for testing internal framework code
create user UT3_TESTER identified by "${TEST_PASSWORD}" default tablespace ${UT3_TABLESPACE} quota unlimited on ${UT3_TABLESPACE};
grant create session, create procedure, create type, create table to UT3_TESTER;
alter user UT3_TESTER enable editions;
grant execute on dbms_lock to UT3_TESTER;

begin
  for i in (
    select object_name from all_objects t
      where t.object_type in ('PACKAGE','TYPE')
      and owner = '${UT3_DEVELOP_SCHEMA}'
      and generated = 'N'
      and object_name not like 'SYS%')
  loop
    execute immediate 'grant execute on ${UT3_DEVELOP_SCHEMA}."'||i.object_name||'" to UT3_TESTER';
  end loop;
end;
/

begin
  for i in ( select table_name from all_tables t where owner = '${UT3_DEVELOP_SCHEMA}' and nested = 'NO' and iot_name is null)
  loop
    execute immediate 'grant select on ${UT3_DEVELOP_SCHEMA}.'||i.table_name||' to UT3_TESTER';
  end loop;
end;
/

PROMPT Creating UT3_USER - minimal privileges user for API testing
create user UT3_USER identified by "${TEST_PASSWORD}" default tablespace ${UT3_TABLESPACE} quota unlimited on ${UT3_TABLESPACE};
grant create session, create procedure, create type, create table to UT3_USER;
alter user UT3_USER enable editions;
grant debug connect session to UT3_USER;
grant debug any procedure to UT3_USER;
begin
  \$if dbms_db_version.version <= 11 \$then
    null;
  \$else
    dbms_network_acl_admin.append_host_ace (
      host =>'*',
      ace  => sys.xs\$ace_type(
                  privilege_list => sys.xs\$name_list('JDWP') ,
                  principal_name => 'UT3_USER',
                  principal_type => sys.xs_acl.ptype_db
              )
    );
  \$end
end;
/

PROMPT Creating UT3_TESTER_HELPER - provides functions to allow min grant test user setup tests.
create user UT3_TESTER_HELPER identified by "${TEST_PASSWORD}" default tablespace ${UT3_TABLESPACE} quota unlimited on ${UT3_TABLESPACE};
grant create session, create procedure, create type, create table to UT3_TESTER_HELPER;

PROMPT Grants for testing distributed transactions
grant create public database link to UT3_TESTER_HELPER;
grant drop public database link to UT3_TESTER_HELPER;

PROMPT Grants for testing coverage outside of main ${UT3_DEVELOP_SCHEMA} schema
grant create any procedure, drop any procedure, execute any procedure, create any type, drop any type, execute any type, under any type,
  select any table, update any table, insert any table, delete any table, create any table, drop any table, alter any table,
  select any dictionary, create any synonym, drop any synonym,
  grant any object privilege, grant any privilege, create public synonym, drop public synonym, create any trigger, drop any trigger
  to UT3_TESTER_HELPER;

grant create job to UT3_TESTER_HELPER;

PROMPT Additional grants for disabling DDL trigger and testing parser without trigger enabled/present
grant alter any trigger to UT3_TESTER_HELPER;
grant administer database trigger to UT3_TESTER_HELPER;
grant execute on dbms_lock to UT3_TESTER_HELPER;

create user ut3_cache_test_owner identified by "${TEST_PASSWORD}";
grant create session, create procedure to ut3_cache_test_owner;

create user ut3_no_extra_priv_user identified by "${TEST_PASSWORD}";
grant create session, create procedure to ut3_no_extra_priv_user;

create user ut3_select_catalog_user identified by "${TEST_PASSWORD}";
grant create session, create procedure, select_catalog_role to ut3_select_catalog_user;

create user ut3_select_any_table_user identified by "${TEST_PASSWORD}";
grant create session, create procedure, select any table to ut3_select_any_table_user;

create user ut3_execute_any_proc_user identified by "${TEST_PASSWORD}";
grant create session, create procedure, execute any procedure to ut3_execute_any_proc_user;

PROMPT Forcing immediate listener registration for ${TARGET_PDB} so we can log in over the network right away
alter system register;

EXIT
SQL

echo "CONTAINER: DONE: Creating utPLSQL test users."

# Die Testpakete gehoeren den frisch angelegten Usern und muessen deshalb per
# echtem Login installiert werden (nicht per "alter session set current_schema",
# das wuerde die "owner = USER"-Validierung und die "grant ... to public"-Loops
# in den *.sql-Skripten unbrauchbar bzw. gefaehrlich machen, da sie sich sonst
# auf SYS statt auf das Test-Schema beziehen wuerden).
#
# Lokale PDB-User koennen nicht per Bequeath (OS-Authentifizierung) erreicht
# werden, sondern nur ueber den Listener - der die neue PDB nach der
# Erstinitialisierung ggf. noch nicht sofort registriert hat. Daher: kurzer
# Retry mit Backoff statt eines fixen "sleep".
CONNECTION_STR="localhost:1521/${TARGET_PDB}"

wait_for_connect() {
  local user="$1"
  local password="$2"
  local attempt
  for attempt in $(seq 1 30); do
    if echo "exit" | sqlplus -s "${user}/${password}@//${CONNECTION_STR}" &> /dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "CONTAINER: ERROR: could not log in as ${user}@//${CONNECTION_STR} after 60s." >&2
  return 1
}

echo "CONTAINER: Installing utPLSQL test suite into PDB '${TARGET_PDB}'..."

cd /opt/utplsql/test

wait_for_connect UT3_TESTER_HELPER "${TEST_PASSWORD}"
sqlplus -s "UT3_TESTER_HELPER/${TEST_PASSWORD}@//${CONNECTION_STR}" @install_ut3_tester_helper.sql

sqlplus -s "UT3_USER/${TEST_PASSWORD}@//${CONNECTION_STR}" @install_ut3_user_tests.sql

sqlplus -s "UT3_TESTER/${TEST_PASSWORD}@//${CONNECTION_STR}" @install_ut3_tester_tests.sql

echo "CONTAINER: DONE: Installing utPLSQL test suite."
