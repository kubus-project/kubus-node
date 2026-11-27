FROM ghcr.io/nerfstudio-project/nerfstudio:1.1.5

USER root
WORKDIR /worker
RUN python -m pip install --no-cache-dir fastapi==0.141.1 uvicorn==0.52.1 gsplat==1.4.0
COPY server.py gpu_tier.py job_control.py video_pipeline.py photo_pipeline.py scene_frame.py face_mask.py source_set.py splat_variants.py /worker/
# Face detector weights (YuNet, MIT): pinned and checked against their SHA-256 here and again at every use.
COPY models /worker/models
RUN echo "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  /worker/models/face_detection_yunet_2023mar.onnx" | sha256sum -c -
ENV PYTHONUNBUFFERED=1 KUBUS_SPATIAL_MAX_ITERATIONS=15000
EXPOSE 8790
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8790"]
