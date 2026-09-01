FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/home/cleo \
    CLEO_HOME=/app \
    CLEO_CONFIG_PATH=/config/cleo.json \
    CLEO_HARNESSES_CONFIG_PATH=/config/harnesses.json

ARG CLEO_UID=10001
ARG CLEO_GID=10001
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_EXTRA_INDEX_URL

RUN groupadd --gid "${CLEO_GID}" cleo \
    && useradd --uid "${CLEO_UID}" --gid "${CLEO_GID}" --create-home --shell /bin/bash cleo \
    && apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --requirement requirements.txt

COPY . .
RUN python -m pip install --no-cache-dir --no-deps . \
    && mkdir -p /config assets data/session_artifacts memory/non_productivity/projects \
        memory/productivity/projects workspace /home/cleo/.codex \
    && cp cleo/images/assets/cleo-startup.png assets/startup.png \
    && chown -R cleo:cleo /app /config /home/cleo \
    && cleo --help >/dev/null

USER cleo

STOPSIGNAL SIGINT
ENTRYPOINT ["cleo"]
