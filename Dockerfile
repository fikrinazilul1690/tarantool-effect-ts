FROM tarantool/tarantool:3.8.0

USER root
COPY learn-tarantool-1.0.0-1.rockspec /tmp/learn-tarantool-1.0.0-1.rockspec
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates cmake build-essential unzip \
    && cd /tmp \
    && tt rocks make --tree /usr/local learn-tarantool-1.0.0-1.rockspec \
    && apt-get purge -y --auto-remove git cmake build-essential unzip \
    && rm -rf /var/lib/apt/lists/* /tmp/learn-tarantool-1.0.0-1.rockspec
WORKDIR /opt/tarantool/app
