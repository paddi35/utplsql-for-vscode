#!/bin/bash
# Legt einen zweiten, bewusst rechtearmen Schema-User an.
#
# dbaView.test.ts (Issue #15) braucht genau zwei Verbindungen mit
# unterschiedlicher Sicht auf das Data Dictionary: das utPLSQL-Schema, das
# dba_objects lesen darf, und einen User, der das nicht darf und deshalb auf
# die all_-Views zurueckfaellt. Der Bug war, dass die erste Probe das Praefix
# fuer alle Profile der Session festlegte -- ohne zweiten User ist das
# schlicht nicht nachstellbar, und die drei Tests ueberspringen sich.
#
# CREATE SESSION ist alles, was der User bekommt. Das reicht:
#
#   - Die all_-Views sind ueber PUBLIC lesbar, liefern ihm aber nur, was er
#     sehen darf -- also nichts aus dem utPLSQL-Schema. Die Tests pruefen an
#     dieser Stelle auch nur, dass die Aufrufe *nicht* mit ORA-00942
#     scheitern, nicht dass Zeilen zurueckkommen.
#   - dba_objects bleibt ihm verwehrt, was hier der eigentliche Punkt ist.
#
# Kein Tablespace-Quota, keine Objektrechte, keine Rolle. Wer den User fuer
# etwas anderes braucht, erweitert ihn bewusst -- nicht hier.
#
# Wird von container-entrypoint.sh beim allerersten Start ausgefuehrt.
set -Eeuo pipefail

TARGET_PDB="${UTPLSQL_TARGET_PDB:-FREEPDB1}"
UNPRIV_USER="${UTPLSQL_IT_UNPRIV_USER:-utplsql_vsc_unpriv}"
UNPRIV_PASSWORD="${UTPLSQL_IT_UNPRIV_PASSWORD:-${ORACLE_PASSWORD}}"

echo "CONTAINER: Creating unprivileged integration-test user '${UNPRIV_USER}' in PDB '${TARGET_PDB}'..."

sqlplus -s / as sysdba <<SQL
WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET CONTAINER=${TARGET_PDB};
CREATE USER ${UNPRIV_USER} IDENTIFIED BY "${UNPRIV_PASSWORD}";
GRANT CREATE SESSION TO ${UNPRIV_USER};
EXIT
SQL

echo "CONTAINER: DONE: Creating unprivileged integration-test user."
