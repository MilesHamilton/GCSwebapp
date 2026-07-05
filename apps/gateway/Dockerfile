# Dev image for the GCS gateway — the fan-in aggregator that fronts a fleet of
# producer containers. Pure relay: no sim, no clock. It owns host port 8000 (the
# browser's /ws) and accepts producers on /ingest.
# Prod path: drop --reload, add --workers 1 (shared in-process registry needs one worker).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# deps first, so the layer cache survives source edits
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# run as non-root
RUN useradd --create-home app
USER app

# baked in for a standalone image; the compose bind mount overrides it in dev
COPY --chown=app:app . .

EXPOSE 8000
# --ws-ping-* so a docker-killed / partitioned producer is detected in ~20-40 s and
# pruned (a silent half-open socket would otherwise block receive for ~TCP-keepalive).
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--ws-ping-interval", "20", "--ws-ping-timeout", "20"]
