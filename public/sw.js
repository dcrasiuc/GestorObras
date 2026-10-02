// "Kill switch": este service worker reemplaza a una versión vieja (anterior a que
// se desactivara el registro de SW en index.html) que quedó activa en algunos
// navegadores/instalaciones PWA, cacheando "/" y el bundle JS para siempre y
// bloqueando cualquier actualización — incluyendo el fix del login con Google
// que se queda cargando sin fin (bug reportado octubre 2026).
//
// Un service worker viejo nunca deja de controlar la página solo porque el HTML
// cambie: el HTML que lo desregistraría está atrapado detrás del propio SW viejo,
// que lo sigue sirviendo desde su caché. La única salida es publicar un sw.js con
// bytes distintos — el navegador SIEMPRE revisa sw.js por red, nunca a través del
// SW activo — para que se instale esta versión nueva, borre todas las cachés y se
// desregistre a sí misma, liberando a la página para pedir todo de nuevo por red.
//
// Dejar este archivo así un tiempo (no hace falta revertirlo); una vez que todos
// los navegadores/instalaciones afectados pasaron por acá, no vuelve a hacer nada.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.map(k => caches.delete(k)))
      await self.registration.unregister()

      const clientsList = await self.clients.matchAll({ type: 'window' })
      clientsList.forEach(client => {
        try { client.navigate(client.url) } catch (_) {}
      })
    })()
  )
})

// Sin listener de 'fetch': todas las requests van directo a red mientras
// esta versión esté instalándose/activándose (y después, ya no hay SW).
