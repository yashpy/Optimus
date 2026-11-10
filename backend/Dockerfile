FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY mission_log ./mission_log
COPY wsgi.py .

# Run as an unprivileged user.
RUN useradd --create-home appuser && mkdir -p /data && chown appuser /data
USER appuser
ENV DATABASE_PATH=/data/mission_log.db

# Cloud Run sets $PORT (default 8080).
CMD exec gunicorn --bind ":${PORT:-8080}" --workers 1 --threads 8 --timeout 30 wsgi:app
