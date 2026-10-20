# TopReview

QR por camarero → valoración en 10 segundos → reseña en Google, con panel del encargado en tiempo real.

- **Portada para dueños:** `/`
- **Página para camareros:** `/camareros?local=<slug-del-local>`
- **Acceso (dueños y encargados):** `/login`
- **Panel (dueños y encargados):** `/panel` — menú lateral con Inicio, Locales, Camareros, Valoraciones (con Análisis IA), Objetivos y bonus, y Configuración
- **Página del cliente al escanear:** `/r/<camarero>`
- **Panel privado del camarero:** `/me/<token>`

## Requisitos

Node.js 22.5 o superior (usa el SQLite integrado de Node). Necesita un servidor con disco persistente para la base de datos.

## Arrancar en local

```bash
npm install
ADMIN_PASSWORD=una-clave npm start
# http://localhost:3000 · acceso en /login con usuario admin
```

## Variables de entorno

| Variable | Para qué sirve |
|---|---|
| `ADMIN_USER` | Usuario del portal principal (por defecto `admin`) |
| `ADMIN_PASSWORD` | Contraseña del portal principal |
| `DATA_DIR` | Carpeta de la base de datos (en Railway, el volumen montado en `/data`) |
| `BASE_URL` | Dirección pública que va dentro de los QR |
| `PORT` | Puerto (Railway lo fija solo) |
| `ANTHROPIC_API_KEY` | Opcional. Activa el análisis con IA en Valoraciones |
| `AI_MODEL` | Opcional. Modelo de IA (por defecto `claude-sonnet-4-5`) |
| `AI_MONTHLY_LIMIT` | Opcional. Análisis con IA por local y mes (por defecto 30) |

## Despliegue en Railway

1. Servicio desde este repositorio, con un volumen montado en `/data`.
2. Variables: `DATA_DIR=/data`, `ADMIN_PASSWORD` (por ejemplo `${{secret(16)}}`), `BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`.
3. Generar el dominio público en *Settings → Networking*.

La carpeta `docs/` es la versión estática de la portada y de la página de camareros para GitHub Pages; lee los datos públicos de la app en Railway.
