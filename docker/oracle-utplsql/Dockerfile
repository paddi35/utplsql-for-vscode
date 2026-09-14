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
# Beide unabhaengig von UTPLSQL_TAG fest verdrahtet, statt sie zur Build-Zeit
# aus derselben Quelle wie das ZIP/den Tag selbst nachzuladen: eine
# .sha256-Datei aus demselben GitHub-Release wie das ZIP praeft nur auf
# Uebertragungsfehler, nicht auf ein manipuliertes Release, und ein Git-Tag
# ist nachtraeglich verschiebbar. Mit hier committeten Werten faellt beides
# auf, statt stillschweigend vertraut zu werden. Bei einem Bump von
# UTPLSQL_TAG muessen beide mit aktualisiert werden:
#   curl -fsSL -o utPLSQL.zip "https://github.com/utPLSQL/utPLSQL/releases/download/<tag>/utPLSQL.zip" && sha256sum utPLSQL.zip
#   git ls-remote --tags https://github.com/utPLSQL/utPLSQL.git <tag>
ARG UTPLSQL_ZIP_SHA256=6e650fc497bce02ae611e185e66c72204f0b984a024a41733b5452e7fb6db47a
ARG UTPLSQL_GIT_SHA=70fba481105b6f0e4ffd68b3282939bb55573710

# ---- Stage 1: utPLSQL-Release herunterladen und entpacken ----
FROM alpine:3.20 AS utplsql-src
ARG UTPLSQL_TAG
ARG UTPLSQL_ZIP_SHA256
ARG UTPLSQL_GIT_SHA

RUN apk add --no-cache curl unzip git \
    && curl -fsSL -o /tmp/utPLSQL.zip \
         "https://github.com/utPLSQL/utPLSQL/releases/download/${UTPLSQL_TAG}/utPLSQL.zip" \
    && cd /tmp \
    && [ "$(sha256sum utPLSQL.zip | cut -d' ' -f1)" = "${UTPLSQL_ZIP_SHA256}" ] \
    && unzip -q utPLSQL.zip \
    && mv utPLSQL /utplsql \
    && rm utPLSQL.zip \
    # Das Release-ZIP enthaelt nur "source" & Co., nicht die Test-Suite (test/).
    # Der utPLSQL-Git-Tag ist identisch zum Release-Tag (z.B. "v.3.2.3"), daher
    # holen wir test/ direkt per Shallow-Clone aus dem getaggten Commit -- und
    # pruefen den geklonten Commit gegen UTPLSQL_GIT_SHA, damit ein seither
    # verschobener Tag auffaellt statt stillschweigend vertraut zu werden.
    && git clone --quiet --depth 1 --branch "${UTPLSQL_TAG}" \
         https://github.com/utPLSQL/utPLSQL.git /tmp/utplsql-git \
    && [ "$(git -C /tmp/utplsql-git rev-parse HEAD)" = "${UTPLSQL_GIT_SHA}" ] \
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
COPY --chown=oracle:oinstall init-scripts/05-validate-credentials.sh  /container-entrypoint-initdb.d/05-validate-credentials.sh
COPY --chown=oracle:oinstall init-scripts/10-install-utplsql.sh       /container-entrypoint-initdb.d/10-install-utplsql.sh
COPY --chown=oracle:oinstall init-scripts/15-grant-dictionary-access.sh     /container-entrypoint-initdb.d/15-grant-dictionary-access.sh
COPY --chown=oracle:oinstall init-scripts/16-create-unprivileged-user.sh /container-entrypoint-initdb.d/16-create-unprivileged-user.sh
COPY --chown=oracle:oinstall init-scripts/20-install-utplsql-tests.sh /container-entrypoint-initdb.d/20-install-utplsql-tests.sh

USER root
RUN chmod +x /container-entrypoint-initdb.d/05-validate-credentials.sh \
              /container-entrypoint-initdb.d/10-install-utplsql.sh \
              /container-entrypoint-initdb.d/15-grant-dictionary-access.sh \
              /container-entrypoint-initdb.d/16-create-unprivileged-user.sh \
              /container-entrypoint-initdb.d/20-install-utplsql-tests.sh
USER oracle

# Das Basis-Image bringt /opt/oracle/healthcheck.sh mit (exit 0, sobald die DB
# offen ist, sonst 2), deklariert aber keine HEALTHCHECK-Instruktion --
# nachgeprueft mit "docker image inspect --format '{{json .Config.Healthcheck}}'",
# das liefert null. Ohne diese Zeile bleibt .State.Health.Status dauerhaft leer,
# und die Warteschleife in .github/workflows/integration.yml, die auf "healthy"
# pollt, laeuft zwangslaeufig in ihr Timeout -- egal wie schnell die Datenbank
# tatsaechlich oben ist.
HEALTHCHECK --interval=10s --timeout=10s --start-period=30s --retries=60 CMD /opt/oracle/healthcheck.sh
