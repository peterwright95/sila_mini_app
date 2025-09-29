import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export default defineConfig({
  server: {
    port: 5173,
    open: false
  },
  build: {
    target: 'esnext'
  },
  plugins: [
    {
      name: 'rasters-api-and-serving',
      configureServer(server) {
        const rootDir = path.dirname(fileURLToPath(import.meta.url));
        const defaultDir = process.env.VITE_RASTER_DIR || process.env.RASTER_DIR || 'biodiversity_rasters';
        const basemapDir = path.resolve(rootDir, 'basemap_tiles');

        function resolveRasterPath(dir, rel) {
          const base = path.resolve(rootDir, dir || defaultDir);
          const safe = path.resolve(base, rel || '');
          if (!safe.startsWith(base)) throw new Error('Invalid path');
          return safe;
        }

        function listDirectories(dir) {
          if (!fs.existsSync(dir)) return [];
          return fs.readdirSync(dir, { withFileTypes: true })
            .filter(ent => ent.isDirectory())
            .map(ent => ent.name)
            .sort();
        }

        function listFilesRecursive(dir, exts) {
          const out = [];
          function walk(d, relBase = '') {
            const entries = fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [];
            for (const ent of entries) {
              const abs = path.join(d, ent.name);
              const rel = path.join(relBase, ent.name);
              if (ent.isDirectory()) {
                walk(abs, rel);
              } else {
                const ext = path.extname(ent.name).toLowerCase();
                if (exts.includes(ext)) out.push(rel);
              }
            }
          }
          walk(dir);
          return out.sort();
        }

        // List rasters: /api/rasters?dir=<folder>
        server.middlewares.use('/api/rasters', (req, res) => {
          try {
            const url = new URL(req.url, 'http://localhost');
            const dir = url.searchParams.get('dir') || defaultDir;
            const base = path.resolve(rootDir, dir);
            const files = listFilesRecursive(base, ['.tif', '.tiff']);
            const result = files.map(f => ({
              file: f,
              label: path.basename(f).replace(/\.(tif|tiff)$/i, '').replace(/_/g, '-'),
            }));
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ dir, items: result }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e && e.message || e) }));
          }
        });

        server.middlewares.use('/api/basemaps', (_req, res) => {
          try {
            const dirs = listDirectories(basemapDir);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ dates: dirs }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e && e.message || e) }));
          }
        });

        server.middlewares.use('/basemap', (req, res, next) => {
          try {
            const reqPath = decodeURIComponent(req.url.replace(/^\/basemap/, ''));
            const filePath = path.resolve(basemapDir, '.' + reqPath);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
              const ext = path.extname(filePath).toLowerCase();
              res.setHeader('Access-Control-Allow-Origin', '*');
              if (ext === '.png') res.setHeader('Content-Type', 'image/png');
              else if (ext === '.jpg' || ext === '.jpeg') res.setHeader('Content-Type', 'image/jpeg');
              else res.setHeader('Content-Type', 'application/octet-stream');
              if ((req.method || 'GET').toUpperCase() === 'HEAD') {
                try {
                  const stat = fs.statSync(filePath);
                  res.setHeader('Content-Length', String(stat.size));
                } catch {}
                res.statusCode = 200;
                res.end();
              } else {
                fs.createReadStream(filePath).pipe(res);
              }
            } else {
              next();
            }
          } catch (_) {
            next();
          }
        });

        // Serve raster bytes via query: /rasters?dir=<folder>&file=<relative>
        server.middlewares.use('/rasters', (req, res) => {
          try {
            const url = new URL(req.url, 'http://localhost');
            const dir = url.searchParams.get('dir') || defaultDir;
            const rel = url.searchParams.get('file') || '';
            const filePath = resolveRasterPath(dir, rel);
            if (!(fs.existsSync(filePath) && fs.statSync(filePath).isFile())) {
              res.statusCode = 404; return res.end('Not Found');
            }
            const stat = fs.statSync(filePath);
            const method = (req.method || 'GET').toUpperCase();
            const range = req.headers['range'];
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'image/tiff');
            res.setHeader('Accept-Ranges', 'bytes');
            if (method === 'HEAD') {
              res.statusCode = 200;
              res.setHeader('Content-Length', String(stat.size));
              return res.end();
            }
            if (method === 'GET' && range) {
              const match = /bytes=(\d*)-(\d*)/.exec(String(range));
              let start = 0; let end = stat.size - 1;
              if (match) {
                if (match[1]) start = parseInt(match[1], 10);
                if (match[2]) end = parseInt(match[2], 10);
                if (Number.isNaN(start)) start = 0;
                if (Number.isNaN(end) || end < start) end = Math.min(start + 1024 * 1024 - 1, stat.size - 1);
              }
              start = Math.max(0, start);
              end = Math.min(end, stat.size - 1);
              const chunkSize = end - start + 1;
              res.statusCode = 206;
              res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
              res.setHeader('Content-Length', String(chunkSize));
              fs.createReadStream(filePath, { start, end }).pipe(res);
            } else if (method === 'GET') {
              res.statusCode = 200;
              res.setHeader('Content-Length', String(stat.size));
              fs.createReadStream(filePath).pipe(res);
            } else {
              res.statusCode = 405; res.end('Method Not Allowed');
            }
          } catch (e) {
            res.statusCode = 500; res.end(String(e && e.message || e));
          }
        });
      },
      closeBundle() {
        const rootDir = path.dirname(fileURLToPath(import.meta.url));
        const defaultDir = process.env.VITE_RASTER_DIR || process.env.RASTER_DIR || 'biodiversity_rasters';
        const src = path.resolve(rootDir, defaultDir);
        const dest = path.resolve(rootDir, 'dist', 'rasters');
        try {
          fs.mkdirSync(dest, { recursive: true });
          if (fs.existsSync(src)) {
            fs.cpSync(src, dest, { recursive: true });
          }
        } catch { /* ignore */ }

        try {
          const basemapSrc = path.resolve(rootDir, 'basemap_tiles');
          const basemapDest = path.resolve(rootDir, 'dist', 'basemap');
          if (fs.existsSync(basemapSrc)) {
            fs.mkdirSync(basemapDest, { recursive: true });
            fs.cpSync(basemapSrc, basemapDest, { recursive: true });
          }
        } catch { /* ignore */ }
      }
    }
  ]
});
