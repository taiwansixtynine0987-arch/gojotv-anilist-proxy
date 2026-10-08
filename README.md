# GojoTV AniList Proxy

A lightweight, cached proxy for the AniList GraphQL API, designed to run on Deno Deploy.

## Why

AniList blocks Cloudflare Workers and some datacenter IPs. This proxy sits in front of AniList, adds caching + rate limiting, and exposes a simple POST `/graphql` endpoint.

## Endpoints

### `GET /health`
Returns service status.

### `POST /graphql`
Proxies GraphQL queries to `https://graphql.anilist.co`.

**Example:**
```bash
curl -X POST "https://YOUR-PROXY.deno.dev/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{Media(id: 113415, type: ANIME) {id title {romaji english} bannerImage}}"}' 
