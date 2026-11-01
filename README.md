# astiko-ktel-live

Where the Kastoria city buses are right now. The phone in each bus, running the drivers' app ([astiko-ktel-odigoi](https://github.com/Kastoria-Dev-Core/astiko-ktel-odigoi)), sends its position here, and the passenger app ([astiko-ktel-kastorias-app](https://github.com/Kastoria-Dev-Core/astiko-ktel-kastorias-app)) reads it to show the buses on the map and the live times at the stops.

It's a Vercel project next to [astiko-ktel-announcements](https://github.com/Kastoria-Dev-Core/astiko-ktel-announcements), using the same Upstash Redis:

```
https://astiko-ktel-live.vercel.app/api/positions
```

## The API

### `POST /api/positions`, from the drivers' phones

Needs `Authorization: Bearer <key>` with a key from `DEVICE_KEYS`. The body is a batch of positions of one trip:

```json
{
  "vehicle": "12",
  "trip": "6f1c0e4e-3c1b-4a59-9a0e-2b1f4c7d8e90",
  "line": "04",
  "direction": "out",
  "points": [
    { "t": "2026-10-31T08:15:02Z", "lat": 40.52140, "lng": 21.26187, "accuracy": 8.0, "speed": 5.2, "bearing": 120.0 }
  ],
  "ended": false
}
```

* Only the newest position of each bus is kept, in one Redis hash (`astiko-ktel:live`, one field per vehicle). A position more than 3 minutes old when it arrives was held back with no signal, so it isn't stored as where the bus is
* `ended: true` takes the bus off at once
* `"trip": "test"` is the app's "Δοκιμή σύνδεσης": it checks the key and stores nothing

Answers 200 when stored (or nothing to store), 400 with the reason for a malformed batch, 401 for an unknown key.

### `GET /api/positions`, for the passenger app

Public. The buses heard from in the last 2 minutes, without their trip ids, cached at the edge for 10 seconds:

```json
{
  "updated": "2026-10-31T08:15:31.000Z",
  "buses": [
    { "vehicle": "12", "line": "04", "direction": "out", "lat": 40.5220, "lng": 21.2630, "bearing": 118, "speed": 6.1, "t": "2026-10-31T08:15:27.000Z", "receivedAt": "2026-10-31T08:15:30.000Z" }
  ]
}
```

## Staying on the free plans

Every request is a single Redis command, the phones send every 30 seconds, and the GET's edge cache means the database is read at most every 10 seconds however many passengers look. About ten buses on the road all day stay inside Vercel's and Upstash's free plans.

## Setting it up

The Vercel project needs:

* The Upstash Redis store connected (Storage, then the store, then Connect Project), which adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`
* `DEVICE_KEYS`: the keys the phones may send with, comma-separated. One key for every phone is fine; each phone needs its own vehicle number though. To change a key without stopping any bus, put the old and the new one in, update the phones, then take the old one out

`.env.example` lists them.

## Code

* `api/positions.js` handles the two requests
* `lib/positions.js` does the work with no database: checking a batch, picking the newest position, which buses are fresh, and the key check
* `lib/store.js` connects to Redis

```bash
npm install
npm test
```

`.github/workflows/test.yml` runs the tests on every pull request and push to `main`; Vercel deploys `main`.

## Code documentation

Every function, constant and data shape has JSDoc, and the docs are a site like the two apps':

https://kastoria-dev-core.github.io/astiko-ktel-live/

`.github/workflows/docs.yml` makes it with [JSDoc](https://jsdoc.app/) and publishes it on every push to `main`. To make it locally, into `site/`:

```bash
npm run docs
```

## License

[GNU General Public License v3.0](LICENSE) or later, like the two apps. See [NOTICE](NOTICE).
