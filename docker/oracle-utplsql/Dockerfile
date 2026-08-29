# Oracle Database Free + utPLSQL
#
# Basis-Image: gvenzl/oracle-free (offizielles, schlankes Oracle-Free-Image)
# https://github.com/gvenzl/oci-oracle-free
#
# utPLSQL wird als Release-ZIP von GitHub geladen und beim ersten Containerstart
# per /container-entrypoint-initdb.d-Skript in die Datenbank installiert.
# https://github.com/utPLSQL/utPLSQL/releases

# ARGs, die in FROM-Zeilen verwendet werden, muessen vor dem jeweiligen FROM stehen.
# Tag-Format bei utPLSQL-Releases: "v.<version>" (Punkt nach dem "v"!)
ARG UTPLSQL_TAG=v.3.2.3
ARG ORACLE_IMAGE_TAG=23-slim-faststart

# ---- Stage 1: utPLSQL-Release herunterladen und entpacken ----
FROM alpine:3.20 AS utplsql-src
ARG UTPLSQL_TAG

RUN apk add --no-cache curl unzip git \
    && curl -fsSL -o /tmp/utPLSQL.zip \
         "https://github.com/utPLSQL/utPLSQL/releases/download/${UTPLSQL_TAG}/utPLSQL.zip" \
    && curl -fsSL -o /tmp/utPLSQL.zip.sha256 \
         "https://github.com/utPLSQL/utPLSQL/releases/download/${UTPLSQL_TAG}/utPLSQL.zip.sha256" \
    && cd /tmp \
    && [ "$(sha256sum utPLSQL.zip | cut -d' ' -f1)" = "$(awk -F'= ' '{print $2}' utPLSQL.zip.sha256)" ] \
    && unzip -q utPLSQL.zip \
    && mv utPLSQL /utplsql \
    && rm utPLSQL.zip utPLSQL.zip.sha256 \
    # Das Release-ZIP enthaelt nur "source" & Co., nicht die Test-Suite (test/).
    # Der utPLSQL-Git-Tag ist identisch zum Release-Tag (z.B. "v.3.2.3"), daher
    # holen wir test/ direkt per Shallow-Clone aus dem getaggten Commit.
    && git clone --quiet --depth 1 --branch "${UTPLSQL_TAG}" \
         https://github.com/utPLSQL/utPLSQL.git /tmp/utplsql-git \
    && mv /tmp/utplsql-git/test /utplsql/test \
    && rm -rf /tmp/utplsql-git

# ---- Stage 2: Oracle Free Image mit utPLSQL bestücken ----
FROM gvenzl/oracle-free:${ORACLE_IMAGE_TAG}

LABEL description="Oracle Database Free mit vorinstalliertem utPLSQL"

# utPLSQL-Quellen ins Image kopieren (Owner: oracle, wie im Basis-Image erwartet)
COPY --from=utplsql-src --chown=oracle:oinstall /utplsql /opt/utplsql

# Init-Skripte, die utPLSQL (und optional dessen Test-Suite) beim ersten Start
# in die PDB installieren. Laufen automatisch nach der DB-/PDB-Erstellung,
# vor "DATABASE IS READY TO USE!".
COPY --chown=oracle:oinstall init-scripts/10-install-utplsql.sh       /container-entrypoint-initdb.d/10-install-utplsql.sh
COPY --chown=oracle:oinstall init-scripts/20-install-utplsql-tests.sh /container-entrypoint-initdb.d/20-install-utplsql-tests.sh

USER root
RUN chmod +x /container-entrypoint-initdb.d/10-install-utplsql.sh \
              /container-entrypoint-initdb.d/20-install-utplsql-tests.sh
USER oracle
