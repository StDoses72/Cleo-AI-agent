FROM python:3.12-slim-bookworm

ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_EXTRA_INDEX_URL

RUN python -m pip install \
    --disable-pip-version-check \
    --no-cache-dir \
    --root-user-action=ignore \
    "uv>=0.8,<1"

ENTRYPOINT ["uv"]
