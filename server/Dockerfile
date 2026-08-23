# The reconstruction service runs untrusted archives from the public. It gets a
# minimal image, a non-root user, and no build toolchain in the final layer.
FROM python:3.12-slim AS build

WORKDIR /build
COPY requirements.txt .
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt


FROM python:3.12-slim

# Reconstruction backends are NOT installed here. AliceVision alone is several
# gigabytes and needs a CUDA base image to be worth running, so the choice of
# backend belongs to whoever deploys this, not to the default image. Without one
# installed the service still runs and still answers every endpoint — the
# simulated backend exists precisely so this image is demonstrable as it stands.
#
# To add one, extend this image:
#   FROM ghcr.io/ethical-tech-colab/turnstone-server:latest
#   RUN apt-get update && apt-get install -y colmap && rm -rf /var/lib/apt/lists/*
#   ENV TURNSTONE_BACKEND=colmap

LABEL org.opencontainers.image.title="Turnstone reconstruction service" \
      org.opencontainers.image.description="Photogrammetric reconstruction and final quality assessment for Turnstone session packages" \
      org.opencontainers.image.source="https://github.com/Ethical-Tech-CoLab/turnstone" \
      org.opencontainers.image.licenses="MPL-2.0"

COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TURNSTONE_DATA_DIR=/data/evidence \
    TURNSTONE_PORT=8080

WORKDIR /app
COPY server/turnstone_server /app/turnstone_server
COPY rubric /app/rubric
COPY record /app/record

# The rubric and the disclaimers are the single sources of truth for what a
# quality class means and what a record asserts. Baked into the image rather
# than mounted so a deployment cannot silently score against a different rubric
# than it reports, or assert a paraphrased disclaimer.
ENV TURNSTONE_RUBRIC=/app/rubric/heritage-v1.json \
    TURNSTONE_DISCLAIMERS=/app/record/disclaimers-v1.json

RUN useradd --create-home --uid 10001 turnstone \
 && mkdir -p /data/evidence \
 && chown -R turnstone:turnstone /data/evidence /app
USER turnstone

VOLUME ["/data/evidence"]
EXPOSE 8080

# Checks the app, not just the process. A uvicorn that is up but whose data
# directory is unwritable would otherwise report healthy while failing every
# upload.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/_health', timeout=4).status==200 else 1)"

CMD ["python", "-m", "turnstone_server"]
