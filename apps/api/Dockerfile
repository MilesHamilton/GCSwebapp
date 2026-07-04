# Dev image for the GCS API + autonomy sim. SINGLE container: the sim is an asyncio
# task inside FastAPI (the VehicleSim class is the seam a real GCS/autopilot split
# would go, so no second container / IPC bus is needed yet).
# Prod path: drop --reload, add --workers N, and/or a multi-stage build.
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
# flat imports -> run main:app from /app. Dev uses --reload for hot edits.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
