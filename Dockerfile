FROM tarantool/tarantool:3.8.0

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates cmake build-essential unzip \
    && tt rocks install checks 3.4.1-1 \
    && tt rocks install errors 2.2.1-1 \
    && tt rocks install vshard 0.1.42-1 \
    && tt rocks install crud 1.7.5-1 \
    && apt-get purge -y --auto-remove git cmake build-essential unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/tarantool/app
