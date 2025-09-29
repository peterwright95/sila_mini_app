# SILA Mini Viewer

Mini web application showing biodiversity results for the "Parco della Sila".

A tiny single-page Leaflet app that overlays biodiversity GeoTIFF rasters from `biodiversity_rasters/` on top of daily NASA GIBS MODIS Terra imagery. Each `final_agglomerate_*.tif` file encodes a specific observation window (e.g. `20210629` -> 2021-06-29) and is rendered directly without pre-generated tiles.

## Biodiversity rasters
- Drop your GeoTIFFs into `biodiversity_rasters/`. The default naming scheme `final_agglomerate_<year>_<month?>_<yyyymmdd>_Biodiv_b0.6_g0.3.tif` is parsed so the sidebar shows the correct ISO date.
- Rasters retain their native projection (UTM Zone 33N for the current datasets). The app reads georeferencing metadata, reprojects on the fly when required, and aligns the imagery with a NASA MODIS Terra basemap whose acquisition date matches the active raster(s).
- Basemap tiles can be pre-cached per observation date for the Italian park, so layer toggles stay instant and offline-friendly.
- On load the map automatically fits the combined extent of the rasters so you land on the area covered by the `final_agglomerate` data.

> Tiling is no longer part of the workflow. The previous `scripts/build_tiles.zsh` helper has been removed; rasters are streamed directly via `/rasters`.

## Quick start

1. Install dependencies
   ```sh
   npm install
   ```
2. Start the dev server
   ```sh
   npm run dev
   ```
3. Open the local URL printed by Vite (usually http://localhost:5173). The sidebar lists available rasters with their observation dates; toggle a layer to render it, adjust opacity, or jump to its extent. When a raster is visible the base layer switches to the matching MODIS Terra image for that day; when none are visible the latest raster date is used.

### Optional: Pre-cache MODIS basemap tiles

The app looks for JPEG tiles in `basemap_tiles/<yyyy-mm-dd>/<z>/<y>/<x>.jpg`. To generate them for every biodiversity raster date (bounded to the Calabrian park extent), run:

```sh
# Requires network access
node scripts/precache_basemap.js
```

You can target specific dates or adjust zoom bounds:

```sh
# Only build tiles for June 2021 at zoom levels 5-8
BASEMAP_ZMIN=5 BASEMAP_ZMAX=8 node scripts/precache_basemap.js 2021-06-10 2021-06-29
```

Cached tiles are served locally at `/basemap/...` in dev and copied into the production bundle.

## Download Sentinel-2 basemap scenes

If you prefer Sentinel true-colour imagery as the backdrop, use the helper script to pull Level-2A scenes that match the biodiversity raster dates. You need Copernicus Open Access Hub credentials (set them via `COPERNICUS_USER` / `COPERNICUS_PASS`) and an AOI GeoJSON (for example `geojson_italy/limits_IT_regions.geojson`).

```sh
pip install sentinelsat
COPERNICUS_USER=you COPERNICUS_PASS=secret \
python scripts/download_sentinel.py \
  --aoi geojson_italy/limits_IT_regions.geojson \
  --out sentinel_basemap
```

By default the script infers the dates from filenames in `biodiversity_rasters/`, searches +/- 1 day for Sentinel-2 L2A scenes with <=20% cloud cover, and downloads the best candidate per date. The output lands under `sentinel_basemap/<date>/` with a `download_summary.json` alongside. Use `--dry-run` to see what would be fetched without downloading.

If you see "query string is too long", supply `--simplify-tolerance 0.01` (requires `pip install shapely`) or `--use-bbox` to query with the AOI's bounding box instead of the full polygon.

### Alternative: queue exports through Google Earth Engine

If the Copernicus Hub keeps timing out, you can leverage Google Earth Engine (GEE) to build and export Sentinel-2 composites. Install the Earth Engine CLI and authenticate:

```sh
pip install earthengine-api
earthengine authenticate
```

Then queue one export per biodiversity period (true-colour B4/B3/B2, 10 m) either to Google Drive or to an EE asset:

```sh
python scripts/gee_export_sentinel.py \
  --aoi geojson_italy/italy.geojson \
  --drive-folder sentinel_exports \
  --max-cloud 20 --scale 10 --verbose
```

Monitor progress with `earthengine task list`. Once the tiles are in Drive, download them and place the GeoTIFFs in `basemap_tiles/<label>/` (matching the GEE export label such as `2021_06`).

## Notes
- For best performance serve Cloud Optimized GeoTIFFs (COGs). Non-COG files still work; they just transfer more data up front.
- If you need to override the raster directory, set `VITE_RASTER_DIR=/path/to/rasters` before starting the dev server.
- `VITE_FORCE_EPSG` can force a specific projection number when dealing with malformed GeoTIFF tags.

## Deploy
- Build a static bundle with `npm run build`, then host the `dist/` folder via any static web server. The build step copies the raw GeoTIFFs into `dist/rasters`.

## Troubleshooting
- If a raster fails to appear, check the browser console for reprojection warnings; files with unusual transforms may need to be corrected with GDAL (`gdalwarp`).
- Huge rasters may take a few seconds to colorise in the browser; consider resampling or clipping if necessary.
