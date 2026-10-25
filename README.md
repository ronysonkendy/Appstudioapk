# KENDY APK STUDIO

Web para importar un APK, explorarlo, editar textos, imágenes, propiedades y XML, reconstruirlo, firmarlo y descargarlo.

## Estructura
- `index.html`  -> pantalla (Vercel, GitHub Pages, etc.)
- `backend/`    -> API (Node + Fastify + PostgreSQL)
- `docker/`     -> Dockerfile del backend (aapt, zip, zipalign, apksigner, apktool y Java)
- `tests/`      -> pruebas

## Servicios gratuitos que usa
- Render (backend con Docker), Neon (PostgreSQL), Firebase Authentication (entrada con Google), Cloudinary (respaldo cifrado) y Vercel (pantalla).

## Puesta en marcha
1. Neon: crea una base y copia su URL en `DATABASE_URL`.
2. Firebase: Authentication -> Método de acceso -> activa Google; Dominios autorizados -> agrega tu dominio de Vercel.
3. Render: Web Service con Docker, Dockerfile `docker/backend.Dockerfile`, plan Free y las variables de `.env.example`.
4. Vercel: publica este repositorio (solo se usa `index.html`).
5. En la web: Configuración -> pega la URL del backend -> Diagnóstico.

## Límites
- "Compilada" no significa "probada en un dispositivo".
- La firma es distinta a la original: hay que desinstalar la app original para instalarla.
- Cloudinary gratis admite 10 MB por archivo: los archivos se parten en bloques de 8 MB.
