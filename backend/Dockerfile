FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 app
WORKDIR /app
COPY requirements.txt .
# the pip cache survives between CI builds, so a changed requirement only downloads what changed
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt
COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app
USER app
EXPOSE 8080
# schema migrations run on start (serialized by a Postgres advisory lock); a failed migration fails the deploy, not the live site
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
