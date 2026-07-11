# Order API

A small HTTP API server that accepts orders and depends on several external
systems it does not own, declared through a mix of formats - not just one:

- **Postgres** (via **Prisma**) - persists orders. Local instance in
  `docker-compose.yml`; access configured in `prisma/schema.prisma`.
- **Redis** - caches the most recent order per customer. Local instance in
  `docker-compose.yml`.
- **Kafka** - publishes order-created events for downstream workers. Runs in
  the cluster; see `k8s/kafka-statefulset.yaml`.
- **ClickHouse** - receives order analytics events. Runs in the cluster; see
  `k8s/clickhouse-deployment.yaml`.

## Deployment

The service is containerized with **Docker** (see `Dockerfile`) and deployed
to **ECS** (see `deploy/ecs-task-definition.json`).

## Running locally

```
docker compose up
npx prisma migrate deploy
npm start
```

Postgres, Kafka, Redis, and ClickHouse are all required at runtime - the
server fails to start if any of them is unreachable.
