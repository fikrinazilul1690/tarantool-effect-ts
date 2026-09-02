# Tarantool Connection Pool

The running connection pool, availability policy, retry rules, lifecycle, and
configuration are documented in [TARANTOOL_CLIENT.md](./TARANTOOL_CLIENT.md).

The client intentionally starts with one multiplexed connection per vshard
router. Add more sockets per router only after measurements show that one
socket is the bottleneck; every extra socket increases authentication work,
memory, file descriptors, and shutdown complexity.
