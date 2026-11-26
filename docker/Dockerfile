# Lineage hosted image: the API (with the built web app) and the job worker share this image.
FROM node:22-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx vite build --outDir /web

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 lineage && mkdir -p /data && chown lineage /data
WORKDIR /app
COPY backend/ /app/
RUN pip install --no-cache-dir ".[hosted]"
COPY --from=web /web /usr/local/lib/python3.12/site-packages/marthouse/static
COPY examples/ /app/examples/
USER lineage
ENV MARTHOUSE_MODE=hosted MARTHOUSE_DATA_DIR=/data UV_CACHE_DIR=/data/.uv-cache UV_PYTHON_INSTALL_DIR=/data/.uv-python
EXPOSE 8765
CMD ["uvicorn", "marthouse.main:app", "--host", "0.0.0.0", "--port", "8765", "--proxy-headers"]
