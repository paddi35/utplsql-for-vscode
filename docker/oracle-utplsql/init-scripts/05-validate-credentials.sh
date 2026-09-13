#!/bin/bash
# Validiert alle Schema-/PDB-/User-Namen und Passwoerter, die die
# nachfolgenden Init-Skripte unquotiert in ein per "as sysdba" laufendes
# SQL*Plus-Skript einsetzen -- bevor eines dieser Skripte laeuft.
#
# Namen werden als nackte Bezeichner bzw. als Positionsargument fuer
# install_headless.sql eingesetzt; ein Passwort landet entweder ebenfalls als
# Positionsargument dort, oder in einem doppelt gequoteten "IDENTIFIED BY"-
# Literal. Unvalidiert kann ein Passwort mit Leerzeichen/Newline ein
# Positionsargument aufspalten bzw. eine neue Anweisung einschleusen, oder
# (im doppelt gequoteten Fall) per eingebettetem Anfuehrungszeichen aus dem
# Literal ausbrechen und beliebiges SQL mit SYSDBA-Rechten ausfuehren.
#
# Laeuft bewusst vor 10-install-utplsql.sh, damit ein ungueltiger Wert den
# gesamten Start laut abbricht, statt sich erst spaeter als "Container ist
# hochgekommen, aber das Passwort ist nicht das, was ich gesetzt habe" zu
# zeigen.
set -Eeuo pipefail

IDENTIFIER_RE='^[A-Za-z][A-Za-z0-9_$#]*$'

validate_identifier() {
  local var_name="$1" value="$2"
  if [[ ! "${value}" =~ ${IDENTIFIER_RE} ]]; then
    echo "CONTAINER: ERROR: ${var_name}='${value}' is not a valid Oracle identifier (expected ${IDENTIFIER_RE})." >&2
    exit 1
  fi
}

validate_password() {
  local var_name="$1" value="$2"
  if [[ "${value}" == *'"'* || "${value}" =~ [[:space:]] ]]; then
    echo "CONTAINER: ERROR: ${var_name} contains a double quote or whitespace/newline character, which breaks the SQL*Plus script it is substituted into." >&2
    exit 1
  fi
}

# Dieselbe Default-Kette wie in den jeweiligen Skripten, damit hier genau der
# Wert geprueft wird, der dort auch tatsaechlich verwendet wird.
validate_identifier UTPLSQL_TARGET_PDB "${UTPLSQL_TARGET_PDB:-FREEPDB1}"
validate_identifier UTPLSQL_SCHEMA "${UTPLSQL_SCHEMA:-UT3}"
validate_identifier UTPLSQL_TABLESPACE "${UTPLSQL_TABLESPACE:-USERS}"
validate_identifier UTPLSQL_IT_UNPRIV_USER "${UTPLSQL_IT_UNPRIV_USER:-utplsql_vsc_unpriv}"

validate_password UTPLSQL_SCHEMA_PASSWORD/ORACLE_PASSWORD "${UTPLSQL_SCHEMA_PASSWORD:-${ORACLE_PASSWORD}}"
validate_password UTPLSQL_IT_UNPRIV_PASSWORD/ORACLE_PASSWORD "${UTPLSQL_IT_UNPRIV_PASSWORD:-${ORACLE_PASSWORD}}"
validate_password UTPLSQL_TEST_SCHEMA_PASSWORD/UTPLSQL_SCHEMA_PASSWORD/ORACLE_PASSWORD "${UTPLSQL_TEST_SCHEMA_PASSWORD:-${UTPLSQL_SCHEMA_PASSWORD:-${ORACLE_PASSWORD}}}"

echo "CONTAINER: Credential and identifier validation passed."
