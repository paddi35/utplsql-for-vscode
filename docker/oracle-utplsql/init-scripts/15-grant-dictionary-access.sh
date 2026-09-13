#!/bin/bash
# Gibt dem utPLSQL-Schema genau die Lesezugriffe, die die Integrationstests
# brauchen -- einzeln erteilt, nicht per SELECT ANY DICTIONARY.
#
# v_$session
#   cancel.test.ts prueft, dass ein abgebrochener Reporter-Export keine
#   Session zuruecklaesst, pool.test.ts, dass closePool() die Sessions des
#   Profils wirklich beendet. Beides ist von innerhalb der betroffenen
#   Sessions nicht beobachtbar. Ohne das Grant: ORA-00942.
#
# dba_objects, dba_dependencies, dba_source
#   Die Extension waehlt pro Verbindungsprofil zwischen dem dba_- und dem
#   all_-Praefix, je nachdem was das Profil lesen darf (src/db/utplsqlDao.ts,
#   isDbaViewAccessible). dbaView.test.ts (Issue #15) reproduziert den Bug,
#   dass die erste Probe das Praefix fuer alle Profile festlegte -- dafuer
#   braucht es zwei Verbindungen mit unterschiedlicher Sicht: dieses Schema
#   als die privilegierte und den User aus 16-create-unprivileged-user.sh als
#   die andere. Ohne diese Grants faellt auch dieses Schema auf all_ zurueck,
#   beide Seiten sehen dasselbe, und der Test kann nichts mehr zeigen.
#
# Grants muessen auf die Basisviews (V_$SESSION) gehen, nicht auf die
# oeffentlichen Synonyme (V$SESSION): ein GRANT auf ein Synonym greift in
# Oracle nicht durch. Bei den dba_-Views sind Name und Basisview identisch.
#
# Bewusst nur lesend und nur auf diese vier Views. SELECT ANY DICTIONARY
# waere kuerzer, wuerde dem Schema aber das komplette Dictionary oeffnen.
#
# Wird von container-entrypoint.sh beim allerersten Start ausgefuehrt, nach
# 10-install-utplsql.sh (das das Schema ueberhaupt erst anlegt).
set -Eeuo pipefail

TARGET_PDB="${UTPLSQL_TARGET_PDB:-FREEPDB1}"
UT3_SCHEMA="${UTPLSQL_SCHEMA:-UT3}"

echo "CONTAINER: Granting dictionary read access to '${UT3_SCHEMA}' in PDB '${TARGET_PDB}'..."

sqlplus -s / as sysdba <<SQL
WHENEVER SQLERROR EXIT SQL.SQLCODE
ALTER SESSION SET CONTAINER=${TARGET_PDB};
GRANT SELECT ON sys.v_\$session     TO ${UT3_SCHEMA};
GRANT SELECT ON sys.dba_objects      TO ${UT3_SCHEMA};
GRANT SELECT ON sys.dba_dependencies TO ${UT3_SCHEMA};
GRANT SELECT ON sys.dba_source       TO ${UT3_SCHEMA};
EXIT
SQL

echo "CONTAINER: DONE: Granting dictionary read access."
