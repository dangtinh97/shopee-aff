# SSR Affiliate Redirect Links

Next.js App Router + TypeScript project for intermediate redirect links with Open Graph and Twitter preview metadata.

## Run locally

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3000/xemvideo/abc123
```

## Data source

The app uses this remote JSON file as the link database:

```text
https://raw.githubusercontent.com/dangtinh97/dangtinh97.github.io/refs/heads/master/shopee.json
```

Expected shape:

```json
{
  "abc123": {
    "title": "Video cực hay",
    "description": "Xem ngay",
    "image": "https://example.com/thumb.jpg",
    "target": "https://youtube.com/watch?v=xxxx"
  }
}
```

## Deploy

Deploy directly to Vercel. No database or environment variables are required for the JSON data source.

The data access layer is isolated in `lib/links.ts` and uses `fetch(..., { next: { revalidate: 60 } })`.

Routes:

```text
/xemvideo/abc123  Uses the matching id from the JSON database.
/xemvideo         Uses the first item when no id is provided.
```
