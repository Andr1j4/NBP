# Pokretanje projekta (SR)

## 1) Lokalno (bez Dockera)

### Backend
```bash
cd back
npm install
npm run start
```

### Frontend
```bash
cd client
npm install
npm start
```

### Potrebno pre toga
- Redis i Cassandra moraju raditi.
- Cassandra keyspace/tabele moraju postojati (npr. `turnir`).

## 2) Docker (docker-compose)

```bash
docker compose up --build
```

Servisi:
- `back` → http://localhost:8080
- `client` → http://localhost:3000
- `redis` → localhost:6379
- `cassandra` → localhost:9042

> Napomena: i dalje moraš inicijalno kreirati keyspace/tabele u Cassandri.

## Automatizovana inicijalizacija šeme
```bash
# lokalno
INIT_SCHEMA=1 SCHEMA_FILE=./back/schema.cql npm --prefix ./back run start
```

Ako koristiš Docker, postavi env:
```
INIT_SCHEMA=1
SCHEMA_FILE=/app/schema.cql
```
