#!/bin/bash
# Gibt dem utPLSQL-Schema Lesezugriff auf v$session.
#
# Zwei Integrationstests dieses Repos beobachten Session-Lebenszyklen und
# koennen das ohne dieses Grant nicht: cancel.test.ts prueft, dass ein
# abgebrochener Reporter-Export keine Session zurueck laesst, und
# pool.test.ts prueft, dass closePool() die Sessions des Profils wirklich
# beendet statt sie weiterlaufen zu lassen. Beide scheitern sonst mit
# ORA-00942 ("table or view SYS.V_$SESSION does not exist") -- die Tests
# ueberspringen sich in dem Fall selbst, laufen dann aber eben nicht.
#
# Das Grant muss auf die Basisview V_$SESSION gehen, nicht auf das
# oeffentliche Synonym V$SESSION: ein GRANT auf ein Synonym greift in Oracle
# nicht durch.
#
# Nur lesend und nur auf diese eine View -- kein SELECT ANY DICTIONARY, damit
# die Rechte des Schemas so eng bleiben wie moeglich. Insbesondere bleibt
# dbaView.test.ts' Annahme intakt, dass dieses Schema die dba_-Views NICHT
# sehen kann.
#
# Wird von container-entrypoint.sh beim allerersten Start ausgefuehrt, nach
# 10-install-utplsql.sh (das das Schema ueberhaupt erst anlegt).
set -Eeuo pipefail

TARGET_PDB="${UTPLSQL_TARGET_PDB:-FREEPDB1}"
UT3_SCHEMA="${UTPLSQL_SCHEMA:-UT3}"

echo "CONTAINER: Granting SELECT on v_\$session to '${UT3_SCHEMA}' in PDB '${TARGET_PDB}'..."

sqlplus -s / as sysdba <<SQL
WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET CONTAINER=${TARGET_PDB};
GRANT SELECT ON sys.v_\$session TO ${UT3_SCHEMA};
EXIT
SQL

echo "CONTAINER: DONE: Granting SELECT on v_\$session."
