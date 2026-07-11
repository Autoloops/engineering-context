# Order API

A small HTTP API server that accepts orders and publishes order-created
events to Redis so downstream workers can process them asynchronously.

## Architecture

- `src/server.js` owns the Redis connection and publishes events.
- `src/routes.js` handles the HTTP request and calls into the publisher.

## Running

```
docker compose up
npm start
```

Redis is required at runtime - the server will fail to start if it cannot
connect to the Redis instance declared in `docker-compose.yml`.
