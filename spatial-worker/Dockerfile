ARG NERFSTUDIO_IMAGE=ghcr.io/nerfstudio-project/nerfstudio:1.1.5

# --- Derivative tools -------------------------------------------------------
# Built in a throwaway stage on the same base the worker runs on, so the
# binaries link against the libraries they will meet at runtime and nothing
# from the toolchain reaches the final image.
FROM ${NERFSTUDIO_IMAGE} AS tools
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates build-essential cmake \
 && rm -rf /var/lib/apt/lists/*

# Spark's LOD builder (MIT, World Labs). Pinned to the commit of the v2.1.0 tag:
# the RAD format it writes has to be one the Spark 2.1.0 renderer shipped in the
# app and in the Node GUI can read. `--no-default-features` drops the optional
# GPU spherical-harmonics clustering, which a headless build neither needs nor
# can use.
ARG SPARK_REF=f22236f95fdd8078f0c12e3aab479523d401daf6
ARG RUST_TOOLCHAIN=1.89.0
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${RUST_TOOLCHAIN}
RUN git init /spark && cd /spark \
 && git remote add origin https://github.com/sparkjsdev/spark.git \
 && git fetch --depth 1 origin ${SPARK_REF} && git checkout --detach FETCH_HEAD
RUN cd /spark/rust && cargo build --release --locked -p build-lod --no-default-features

# Niantic's SPZ library with its Python binding (MIT). Pinned to the v3.0.0 tag.
# The library defaults to SPZ version 4, which Spark 2.1.0 cannot read; the
# worker asks for version 3 explicitly (see derivatives.py).
ARG SPZ_REF=5bf2945de1a003cee07133b1e495fe9c6ffdc7e7
ENV CMAKE_ARGS="-DCMAKE_POSITION_INDEPENDENT_CODE=ON"
RUN python -m pip install --no-cache-dir scikit-build-core nanobind python_devtools \
 && python -m pip wheel --no-cache-dir --no-build-isolation --no-deps -w /wheels "git+https://github.com/nianticlabs/spz.git@${SPZ_REF}"

# --- Worker -----------------------------------------------------------------
FROM ${NERFSTUDIO_IMAGE}
USER root
WORKDIR /worker
RUN python -m pip install --no-cache-dir fastapi==0.141.1 uvicorn==0.52.1 gsplat==1.4.0
COPY --from=tools /wheels /tmp/wheels
RUN python -m pip install --no-cache-dir /tmp/wheels/*.whl && rm -rf /tmp/wheels
COPY --from=tools /spark/rust/target/release/build-lod /usr/local/bin/build-lod
ARG SPARK_REF=f22236f95fdd8078f0c12e3aab479523d401daf6
ARG SPZ_REF=5bf2945de1a003cee07133b1e495fe9c6ffdc7e7
RUN mkdir -p /opt/kubus && printf '{"buildLod":{"version":"spark-v2.1.0","ref":"%s"},"spz":{"version":"v3.0.0","ref":"%s"}}\n' "${SPARK_REF}" "${SPZ_REF}" > /opt/kubus/tools.json
COPY server.py gpu_tier.py splat_ply.py derivatives.py worker_errors.py /worker/
ENV PYTHONUNBUFFERED=1 KUBUS_SPATIAL_MAX_ITERATIONS=15000
EXPOSE 8790
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8790"]
