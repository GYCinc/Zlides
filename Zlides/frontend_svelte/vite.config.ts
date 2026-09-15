import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';
import path from 'path';

export default defineConfig(() => {
  let apiKey = process.env.Z_AI_API_KEY || process.env.ZAI_API_KEY || '';
  const secretsPath = '/home/hayron/.secrets.env';
  if (!apiKey && fs.existsSync(secretsPath)) {
    try {
      const content = fs.readFileSync(secretsPath, 'utf8');
      const match = content.match(/(?:Z_AI_API_KEY|ZAI_API_KEY)=["']?([^"'\r\n]+)["']?/);
      if (match) apiKey = match[1];
    } catch (e) {
      console.warn('Could not read .secrets.env:', e);
    }
  }

  const savedSlidesPlugin = () => ({
    name: 'saved-slides-plugin',
    configureServer(server: any) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        // GET /saved -> list all saved slides from saved_slides directory
        if (url.pathname === '/saved' && req.method === 'GET') {
          try {
            const savedDir = path.resolve(__dirname, '../saved_slides');
            if (!fs.existsSync(savedDir)) fs.mkdirSync(savedDir, { recursive: true });

            const files = fs.readdirSync(savedDir);
            const items = [];
            for (const f of files) {
              if (!f.endsWith('.html')) continue;
              const fp = path.join(savedDir, f);
              try {
                const stats = fs.statSync(fp);
                let title = f.replace(/\.html$/, '');
                try {
                  const content = fs.readFileSync(fp, 'utf8');
                  const m = content.match(/<title>(.*?)<\/title>/i);
                  if (m && m[1].trim()) title = m[1].trim();
                } catch (e) {
                  console.warn('vault read failed:', e);
                }

                const d = new Date(stats.mtimeMs);
                items.push({
                  id: f,
                  filename: f,
                  title,
                  createdAt: stats.mtimeMs,
                  modified: stats.mtime.toISOString(),
                  dateStr: d.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                });
              } catch (e) {
                console.warn('vault read failed:', e);
              }
            }
            items.sort((a, b) => b.createdAt - a.createdAt);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(items));
            return;
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
            return;
          }
        }

        // GET /saved/:filename -> fetch individual slide HTML
        if (url.pathname.startsWith('/saved/') && req.method === 'GET') {
          const filename = decodeURIComponent(url.pathname.slice('/saved/'.length));
          const fp = path.resolve(__dirname, '../saved_slides', filename);
          if (fs.existsSync(fp)) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            fs.createReadStream(fp).pipe(res);
            return;
          }
        }

        // POST /save-slide -> save a newly generated slide to disk
        if (url.pathname === '/save-slide' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: any) => (body += chunk));
          req.on('end', () => {
            try {
              let { html, title } = JSON.parse(body);
              const normalizeForSave = (raw: string): string => {
                const SEP = "<!-- zlides:page-break -->";
                const extractBody = (h: string) => {
                  const m = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
                  return m ? m[1].trim() : h.replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<html[^>]*>/gi, "").replace(/<\/html>/gi, "").replace(/<head[\s\S]*?<\/head>/gi, "").trim();
                };
                const extractHead = (h: string) => {
                  const m = h.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
                  return m ? m[1].trim() : '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">';
                };
                const assemble = (pages: string[]): string => {
                  if (pages.length === 0) return raw;
                  const first = pages[0];
                  let headInner = extractHead(first);
                  const fix = `\n<style>\nhtml,body{background:#0f1112 !important;margin:0;padding:0;}\nbody{overflow:auto !important;height:auto !important;min-height:100vh;color:#e5e7eb;}\n.slide{width:100% !important;max-width:1280px !important;margin:0 auto !important;height:auto !important;min-height:0 !important;max-width:100%;}\n</style>`;
                  headInner += fix;
                  const bodies = pages.map(extractBody).join('\n<div class="zlides-page-separator" style="height:1px;background:#2e3236;margin:24px 0;"></div>\n');
                  return `<!DOCTYPE html>\n<html lang="en">\n<head>${headInner}\n</head>\n<body style="background:#0f1112;color:#e5e7eb;margin:0;padding:24px;max-width:100%;overflow:auto;">\n${bodies}\n</body>\n</html>`;
                };
                if (raw.includes(SEP)) {
                  const parts = raw.split(SEP).map((s: string) => s.trim()).filter(Boolean);
                  return assemble(parts);
                }
                const dc = (raw.match(/<!DOCTYPE/gi) || []).length;
                if (dc > 1) {
                  const parts = raw.split(/(?=<!DOCTYPE)/gi).map((s: string) => s.trim()).filter(Boolean);
                  if (parts.length > 1) return assemble(parts);
                }
                return raw;
              };
              html = normalizeForSave(html);
              const savedDir = path.resolve(__dirname, '../saved_slides');
              if (!fs.existsSync(savedDir)) fs.mkdirSync(savedDir, { recursive: true });

              const now = new Date();
              const ts = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
              const clean = (title || 'untitled').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
              const filename = `slide_${ts}_${clean}.html`;
              const fp = path.join(savedDir, filename);

              fs.writeFileSync(fp, html, 'utf8');
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ status: 'ok', filename }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
          return;
        }

        next();
      });
    },
  });

  return {
    plugins: [svelte(), tailwindcss(), savedSlidesPlugin()],
    define: {
      'import.meta.env.VITE_DEFAULT_API_KEY': JSON.stringify(apiKey),
    },
    server: {
      port: 2828,
      host: '0.0.0.0',
    },
    preview: {
      port: 2828,
      host: '0.0.0.0',
    },
    build: {
      outDir: '../public',
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        $lib: path.resolve(__dirname, './src/lib'),
        $contracts: path.resolve(__dirname, './src/contracts'),
      },
    },
  };
});
