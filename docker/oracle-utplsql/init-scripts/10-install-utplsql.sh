#!/bin/bash
# Installiert utPLSQL in die Ziel-PDB.
# Wird von container-entrypoint.sh automatisch beim allerersten Start ausgefuehrt
# (nachdem SYS/SYSTEM-Passwort gesetzt und die PDB erzeugt wurde).
set -Eeuo pipefail

TARGET_PDB="${UTPLSQL_TARGET_PDB:-FREEPDB1}"
UT3_SCHEMA="${UTPLSQL_SCHEMA:-UT3}"
UT3_PASSWORD="${UTPLSQL_SCHEMA_PASSWORD:-${ORACLE_PASSWORD}}"
UT3_TABLESPACE="${UTPLSQL_TABLESPACE:-USERS}"

echo "CONTAINER: Installing utPLSQL as schema '${UT3_SCHEMA}' into PDB '${TARGET_PDB}'..."

cd /opt/utplsql/source

# Verbindung per Betriebssystem-Authentifizierung (bequeath connect), danach
# in die Ziel-PDB wechseln - kein Passwort/Listener-Zugriff noetig.
sqlplus -s / as sysdba <<SQL
WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET CONTAINER=${TARGET_PDB};
@install_headless.sql ${UT3_SCHEMA} ${UT3_PASSWORD} ${UT3_TABLESPACE}
EXIT
SQL

echo "CONTAINER: DONE: Installing utPLSQL."
