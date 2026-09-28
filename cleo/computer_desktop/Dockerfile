FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-aiohttp python3-pil python3-xlib xvfb x11vnc xdotool xclip \
    openbox tint2 pcmanfm mousepad xterm chromium dbus-x11 fonts-noto-cjk \
    ca-certificates x11-utils wmctrl && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash cleo
COPY guest.py /opt/cleo/guest.py
USER cleo
ENV DISPLAY=:99 HOME=/home/cleo LANG=C.UTF-8
EXPOSE 8765
CMD ["dbus-run-session", "--", "python3", "/opt/cleo/guest.py"]
