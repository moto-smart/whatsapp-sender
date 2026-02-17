# Chat Bot (Node.js)

Guía rápida para iniciar la app.

## Requisitos

- Node.js 18+ (recomendado)
- pnpm (o npm)

## Instalación

```bash
pnpm install
```

> Si prefieres npm:
>
> ```bash
> npm install
> ```

## Variables de entorno

Crea un archivo `.env` en la raíz del proyecto:

```env
PORT=3003

# Habilita conexión por QR (Baileys) solo si lo necesitas
USE_BAILEYS=false

# WhatsApp Cloud API (requerido para /send-message, /wa-check, /wa-templates)
WHATSAPP_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=

# SMS 360 (opcional)
SMS360_API_LOGIN=
SMS360_API_KEY=
SMS360_BASE_URL=https://dashboard.360nrs.com/api/rest/sms
```

## Ejecutar

```bash
pnpm start
```

La app quedará disponible en:

- `http://localhost:3003`

## Notas rápidas

- Si `USE_BAILEYS=true`, se genera QR en `public/qr-code.png` para vincular WhatsApp.
- El endpoint principal para mensajes es `POST /send-message`.
