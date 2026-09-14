#!/bin/bash
# Validiert alle Schema-/PDB-/User-Namen und Passwoerter, die die
# nachfolgenden Init-Skripte unquotiert in ein per "as sysdba" laufendes
# SQL*Plus-Skript einsetzen -- bevor eines dieser Skripte laeuft.
#
# Namen werden als nackte Bezeichner bzw. als Positionsargument fuer
# install_headless.sql eingesetzt; ein Passwort landet entweder ebenfalls als
# Positionsargument dort, oder in einem doppelt gequoteten "IDENTIFIED BY"-
# Literal, oder unquotiert in einer sqlplus user/password@//host-Verbindungs-
# zeichenkette (20-install-utplsql-tests.sh). Unvalidiert kann ein Passwort
# mit Leerzeichen/Newline ein Positionsargument aufspalten bzw. eine neue
# Anweisung einschleusen, oder (im doppelt gequoteten Fall) per eingebettetem
# Anfuehrungszeichen aus dem Literal ausbrechen und beliebiges SQL mit
# SYSDBA-Rechten ausfuehren. Ein '&' wird von SQL*Plus (SET DEFINE ON ist
# Standard) auch innerhalb eines doppelt gequoteten Literals als Praefix
# einer Substitutionsvariable gelesen und kann das Passwort verstuemmeln
# oder die naechste Heredoc-Zeile als deren Eingabe konsumieren. Ein '@' oder
# '/' bricht die unquotierte user/password@//host-Verbindungszeichenkette,
# da '/' dort der User/Passwort-Trenner ist.
#
# Laeuft bewusst vor 10-install-utplsql.sh, damit ein ungueltiger Wert den
# gesamten Start laut abbricht, statt sich erst spaeter als "Container ist
# hochgekommen, aber das Passwort ist nicht das, was ich gesetzt habe" zu
# zeigen.
set -Eeuo pipefail

# Oracle's unquoted-identifier length limit is 128 bytes (compatible >= 12.2,
# the default for the gvenzl/oracle-free:23 image this Dockerfile builds on);
# a longer value passes SQL*Plus's own free-form quoting here but fails with
# ORA-00972 deep inside 10-install-utplsql.sh, defeating the fail-fast point
# of this script.
IDENTIFIER_RE='^[A-Za-z][A-Za-z0-9_$#]{0,127}$'

validate_identifier() {
  local var_name="$1" value="$2"
  if [[ ! "${value}" =~ ${IDENTIFIER_RE} ]]; then
    echo "CONTAINER: ERROR: ${var_name}='${value}' is not a valid Oracle identifier (expected ${IDENTIFIER_RE})." >&2
    exit 1
  fi
}

validate_password() {
  local var_name="$1" value="$2"
  if [[ "${value}" == *'"'* || "${value}" == *'&'* || "${value}" == *'@'* || "${value}" == *'/'* || "${value}" =~ [[:space:]] ]]; then
    echo "CONTAINER: ERROR: ${var_name} contains a double quote, '&', '@', '/', or whitespace/newline character, which breaks the SQL*Plus script it is substituted into." >&2
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
