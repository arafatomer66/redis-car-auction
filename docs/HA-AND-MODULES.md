# Phase 18 + 19 — Production HA & Modules

The base `docker-compose.yml` runs a single Redis fine for development. For production-shaped topologies, two extra compose files are wired up.

## Replication (1 master + 1 replica)

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile replica up -d
# verify
docker exec redis-auction-redis redis-cli INFO replication | grep -E "role|connected_slaves"
docker exec redis-auction-replica redis-cli INFO replication | grep -E "role|master_link_status"
```

Test that writes flow:
```bash
docker exec redis-auction-redis redis-cli SET demo hello
docker exec redis-auction-replica redis-cli GET demo   # → "hello"
```

## Sentinel (3-node quorum + 1 replica)

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile sentinel up -d
docker exec redis-auction-sentinel-1 redis-cli -p 26379 sentinel masters
```

**Manual failover demo:**
```bash
# Pause the master — sentinels will declare it down after 5s
docker pause redis-auction-redis
# Watch the failover happen
docker logs -f redis-auction-sentinel-1
# Unpause to see it rejoin as replica
docker unpause redis-auction-redis
```

## Cluster mode (6 nodes — 3 masters + 3 replicas)

Cluster mode uses a completely different topology (hash slots, MOVED redirects), so it lives in its own compose file:

```bash
docker compose -f docker-compose.cluster.yml up -d

# One-time: form the cluster (assigns 16384 slots, sets up replicas)
docker exec -it cl-node-1 redis-cli --cluster create \
  cl-node-1:6379 cl-node-2:6379 cl-node-3:6379 \
  cl-node-4:6379 cl-node-5:6379 cl-node-6:6379 \
  --cluster-replicas 1 --cluster-yes

# Inspect slot map
docker exec -it cl-node-1 redis-cli cluster nodes
docker exec -it cl-node-1 redis-cli cluster slots

# Connect in cluster mode (so MOVED redirects are followed automatically)
docker exec -it cl-node-1 redis-cli -c -p 6379
# > SET {user:123}:profile "..."    # the tag {user:123} pins to one slot
# > SET {user:123}:cart "..."       # same slot → multi-key ops work
```

**Multi-key constraint:** a single command (e.g. `MGET k1 k2`) can only touch keys in the same hash slot. Use **hash tags** (`{tag}` in the key) to force colocation.

## ACL

Run with the example ACL file:
```bash
docker run --rm -v $PWD/ops/users.acl:/etc/users.acl redis:7-alpine \
  redis-server --aclfile /etc/users.acl
```

Then authenticate as a specific user:
```bash
redis-cli -a bidder_password --user bidder
> SET foo bar   # → NOPERM: this user has no permissions to access this command
```

## TLS

Quickest path with Docker is to mount self-signed certs and use `redis-server --tls-port 6380 --port 0 --tls-cert-file ... --tls-key-file ... --tls-ca-cert-file ...`. ioredis supports it via `tls: { ... }` in the connection options. Full walkthrough: <https://redis.io/docs/management/security/encryption/>.

## RedisJSON + RediSearch (modules via `redis-stack`)

The app's base image is `redis:7-alpine` (no modules). To experiment with JSON + search:

```bash
docker compose -f docker-compose.yml -f docker-compose.ha.yml --profile stack up -d
docker exec -it redis-auction-stack redis-cli -p 6379

# RedisJSON
> JSON.SET car:1 $ '{"year":2022,"make":"Toyota","model":"Corolla","price":18000}'
> JSON.GET car:1 $.make
> JSON.NUMINCRBY car:1 $.price 250

# RediSearch
> FT.CREATE cars-idx ON JSON PREFIX 1 car: SCHEMA
    $.make AS make TAG
    $.model AS model TEXT
    $.price AS price NUMERIC SORTABLE
> FT.SEARCH cars-idx '@make:{Toyota}' SORTBY price DESC
> FT.SEARCH cars-idx 'Corolla' RETURN 2 make price
```

The `redis-stack` image binds to host port **6385**, so it never conflicts with the base Redis.
