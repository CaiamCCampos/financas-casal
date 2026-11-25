// Service worker: deixa o app instalável e abre mesmo com internet ruim.
// Arquivos do app: rede primeiro, cache como reserva. A API nunca é guardada.
const CACHE = 'financas-v8';
const ARQUIVOS = ['/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Recebe imagem/PDF/texto do menu "Compartilhar" do celular (Android).
async function receberCompartilhado(req) {
  try {
    const form = await req.formData();
    const cache = await caches.open('compartilhado');
    const arquivo = form.get('arquivo');
    const texto = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join(' ');
    if (arquivo && typeof arquivo !== 'string') {
      await cache.put('/compartilhado/arquivo', new Response(arquivo, { headers: { 'content-type': arquivo.type } }));
    } else if (texto) {
      await cache.put('/compartilhado/texto', new Response(texto));
    }
  } catch (e) {
    console.error(e);
  }
  return Response.redirect('/?compartilhado=1', 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname === '/compartilhar') {
    e.respondWith(receberCompartilhado(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});
