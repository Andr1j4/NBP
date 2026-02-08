# NBP

Napredne Baze Podataka Projekat


# Pokretanje projekta

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
- Cassandra keyspace/tabele moraju postojati, ovde koristimo `turnir`.

## 2) Docker (docker-compose)

### Kreiranje image-a back koji sadrzi cassandru sa kreiranom semom i odgovarajucim tabelama.
```bash
docker compose build back
```

```bash
docker compose up
```

Servisi:
- `back` → http://localhost:8080
- `client` → http://localhost:3000
- `redis` → localhost:6379
- `cassandra` → localhost:9042

### Cassandra i redis su prazni nakon podizanja container-a, potrebno je rucno kreirati turnir kroz admin page i istestirati/koristiti aplikaciju :D 
