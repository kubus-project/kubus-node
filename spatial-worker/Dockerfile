FROM ghcr.io/nerfstudio-project/nerfstudio:1.1.5

USER root
WORKDIR /worker
RUN python -m pip install --no-cache-dir fastapi==0.141.1 uvicorn==0.52.1 gsplat==1.4.0
COPY server.py gpu_tier.py /worker/
ENV PYTHONUNBUFFERED=1 KUBUS_SPATIAL_MAX_ITERATIONS=15000
EXPOSE 8790
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8790"]
