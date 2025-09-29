const express = require('express');
const multer = require('multer');
const upload = multer();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const Sms360Client = require('./sms360');
const axios = require('axios');

// Safe load of environment variables (optional)
try { require('dotenv').config(); } catch (_) {}

const app = express();
app.use(express.json());
app.use(express.static('public'));

let sock;
let currentQR = null;
let messageQueue = [];

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true
    });
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('Evento QR recibido, generando imagen...');
            await qrcode.toFile(path.join(__dirname, 'public', 'qr-code.png'), qr);
            console.log('Código QR generado y guardado.');
        }

        if (update?.error) {
            console.error('Error en conexión:', update.error);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexión cerrada. ¿Debería reconectar?', shouldReconnect);

            if (shouldReconnect) {
                connectToWhatsApp(); // Reconectar automáticamente
            } else {
                console.log('Sesión cerrada. Eliminando credenciales y esperando escaneo de nuevo QR.');
                currentQR = null;

                // Eliminar manualmente los archivos de credenciales
                const authDir = path.join(__dirname, 'auth_info_baileys');
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                    console.log('Credenciales eliminadas.');
                }
                console.log('Reconectando para generar nuevo QR...');
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('Conexión establecida');
            currentQR = null;
            // Eliminar la imagen del código QR si existe
            const qrPath = path.join(__dirname, 'public', 'qr-code.png');
            if (fs.existsSync(qrPath)) {
                fs.unlinkSync(qrPath);
            }
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
}

// Función para guardar el registro de mensajes
function saveMessageRecord(phone, sender, message, imageUrl = null, videoUrl = null) {
    const record = {
        phone,
        timestamp: new Date().toISOString(),
        sender,
        message,
        imageUrl,
        videoUrl
    };

    const filePath = path.join(__dirname, 'messageRecords.json');
    let records = [];

    if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        records = JSON.parse(data);
    }

    records.push(record);
    fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
}

// Función para contar los mensajes enviados hoy
function countMessagesSentToday() {
    const filePath = path.join(__dirname, 'messageRecords.json');
    if (!fs.existsSync(filePath)) {
        return 0;
    }

    const data = fs.readFileSync(filePath);
    const records = JSON.parse(data);
    const today = new Date().toISOString().split('T')[0];

    return records.filter(record => record.timestamp.startsWith(today) && record.sender).length;
}

// Función para actualizar el registro de mensajes
function updateMessageRecord(phone, message, imageUrl = null, videoUrl = null) {
    const filePath = path.join(__dirname, 'messageRecords.json');
    if (!fs.existsSync(filePath)) {
        return;
    }

    const data = fs.readFileSync(filePath);
    let records = JSON.parse(data);

    records = records.map(record => {
        if (
            record.phone === phone &&
            record.message === message &&
            record.imageUrl === imageUrl &&
            record.videoUrl === videoUrl &&
            !record.sender
        ) {
            record.sender = true;
        }
        return record;
    });

    fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
}

// Ruta para obtener el estado del código QR
app.get('/qr-status', (req, res) => {
    const qrExists = fs.existsSync(path.join(__dirname, 'public', 'qr-code.png'));
    res.json({ 
        qrAvailable: qrExists,
        qrPath: qrExists ? '/qr-code.png' : null 
    });
});

// Ruta para enviar un mensaje
app.post('/send-message', upload.none(), async (req, res) => {
    try {
        const { phone, message, limitOfMessages = 200, imageUrl, videoUrl, templateName, templateLang, templateParams, buttonParams } = req.body;

        if (!phone) return res.status(400).json({ error: 'phone es requerido' });
        if (!message && !imageUrl && !videoUrl && !templateName)
            return res.status(400).json({ error: 'Debe enviar message o imageUrl/videoUrl o templateName' });

        // No permitir imagen y video simultáneamente
        if (imageUrl && videoUrl) {
            return res.status(400).json({ error: 'No se puede enviar imagen y video a la vez' });
        }

        const sentToday = countMessagesSentToday();
        if (sentToday >= Number(limitOfMessages)) {
            // Guardar como no enviado
            saveMessageRecord(phone, false, message || null, imageUrl || null, videoUrl || null);
            return res.status(429).json({ error: 'Límite de mensajes diarios alcanzado' });
        }

        // Encolar para envío por Cloud API; marcar como no enviado hasta confirmar
        messageQueue.push({ 
            phone, 
            message: message || null, 
            imageUrl: imageUrl || null, 
            videoUrl: videoUrl || null, 
            templateName: templateName || null, 
            templateLang: templateLang || null,
            templateParams: templateParams || null,
            buttonParams: buttonParams || null
        });
        saveMessageRecord(phone, false, message || null, imageUrl || null, videoUrl || null);

        return res.json({ success: true, message: 'Mensaje en cola para ser enviado por WhatsApp Cloud API' });
    } catch (err) {
        console.error('Error en /send-message:', err);
        return res.status(500).json({ error: 'Error interno' });
    }
});

const smsClient = Sms360Client.configure(config => {
  config.apiLogin = process.env.SMS360_API_LOGIN || 'motosmarttrans';
  config.apiKey = process.env.SMS360_API_KEY || 'NPxk14%!';
  config.baseUrl = process.env.SMS360_BASE_URL || 'https://dashboard.360nrs.com/api/rest/sms';
});

// Nuevo endpoint para enviar SMS
app.post('/sms-message', express.json(), async (req, res) => {
  try {
    const { phone, message, from } = req.body;

    // Validaciones básicas
    if (!phone || !message || !from) {
      return res.status(400).json({
        error: 'Faltan parámetros requeridos: phone, message y from son obligatorios'
      });
    }

    // Convertir teléfono a array si es string
    const phonesArray = Array.isArray(phone) ? phone : [phone];

    // Enviar SMS
    const result = await smsClient.send(phonesArray, message, from);

    console.log(result.error === null);
    if (result.error === null) {
      res.status(200).json({
        success: true,
        message: 'SMS enviado correctamente',
        details: result.data
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Error al enviar SMS',
        details: result.error
      });
    }
  } catch (error) {
    console.error('Error en endpoint /sms-message:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// WhatsApp Cloud API helper
const WA_GRAPH_BASE = 'https://graph.facebook.com/v22.0';

function buildWaPayload({ to, message, imageUrl, videoUrl, templateName, templateLang = 'en_US', templateParams, buttonParams }) {
  if (templateName) {
    const templatePayload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { 
        name: templateName, 
        language: { code: templateLang },
        components: []
      }
    };
    
    // Agregar parámetros del cuerpo si existen
    if (templateParams && templateParams.length > 0) {
      templatePayload.template.components.push({
        type: 'body',
        parameters: templateParams.map(param => ({ type: 'text', text: param }))
      });
    }
    
    // Agregar parámetros de botones si existen
    if (buttonParams && buttonParams.length > 0) {
      templatePayload.template.components.push({
        type: 'button',
        sub_type: 'url',
        index: 0,
        parameters: buttonParams.map(param => ({ type: 'text', text: param }))
      });
    }
    
    return templatePayload;
  }
  if (imageUrl) {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl, caption: message || undefined }
    };
  }
  if (videoUrl) {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'video',
      video: { link: videoUrl, caption: message || undefined }
    };
  }
  return { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } };
}

async function sendWhatsAppCloud({ to, message, imageUrl, videoUrl, templateName, templateLang, templateParams, buttonParams }) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    return { success: false, error: 'Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID env vars' };
  }
  const url = `${WA_GRAPH_BASE}/${phoneNumberId}/messages`;
  const payload = buildWaPayload({ to, message, imageUrl, videoUrl, templateName, templateLang, templateParams, buttonParams });
  
  console.log('Payload enviado a WhatsApp:', JSON.stringify(payload, null, 2));
  
  try {
  const { data } = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
  const hasMsgId = Array.isArray(data?.messages) && data.messages.length > 0;
  return { success: hasMsgId, data };
  } catch (err) {
    console.error('Error completo de axios:', err.response?.data || err.message);
    const details = err.response?.data || err.message;
    return { success: false, error: details };
  }
}

// Procesamiento de la cola de mensajes
setInterval(async () => {
  const batch = messageQueue.splice(0, 4);
  for (const job of batch) {
    const { phone, message, imageUrl, videoUrl, templateName, templateLang, templateParams, buttonParams } = job;
    try {
      const to = String(phone); // E164 sin +
      console.log(`Enviando mensaje a ${phone} con template: ${templateName}, params:`, templateParams, 'buttonParams:', buttonParams);
      const resp = await sendWhatsAppCloud({ to, message, imageUrl, videoUrl, templateName, templateLang, templateParams, buttonParams });
      console.log(`Respuesta completa para ${phone}:`, JSON.stringify(resp, null, 2));
      if (resp.success) {
        updateMessageRecord(phone, message || null, imageUrl || null, videoUrl || null);
        const ids = resp.data?.messages?.map(m => m.id).join(',');
        console.log(`WA Cloud enviado a ${phone} (ids: ${ids || 'n/a'})`);
      } else {
        console.error(`WA Cloud error a ${phone}:`, JSON.stringify(resp, null, 2));
      }
    } catch (e) {
      console.error(`Fallo al enviar a ${job.phone}:`, e);
    }
  }
}, 60000);

// Endpoint de verificación: ¿el número tiene WhatsApp?
app.get('/wa-check', async (req, res) => {
  try {
    const to = (req.query.phone || '').trim();
    if (!to) return res.status(400).json({ error: 'phone es requerido' });
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) {
      return res.status(500).json({ error: 'Faltan WHATSAPP_TOKEN o WHATSAPP_PHONE_NUMBER_ID' });
    }
    const url = `${WA_GRAPH_BASE}/${phoneNumberId}/contacts`;
    const payload = { blocking: 'wait', contacts: [String(to)], messaging_product: 'whatsapp' };
    const { data } = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data || err.message });
  }
});

// Endpoint para listar templates disponibles
app.get('/wa-templates', async (req, res) => {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID; // Necesitas esta variable
    if (!token || !wabaId) {
      return res.status(500).json({ error: 'Faltan WHATSAPP_TOKEN o WHATSAPP_BUSINESS_ACCOUNT_ID' });
    }
    const url = `${WA_GRAPH_BASE}/${wabaId}/message_templates`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000
    });
    res.json({ ok: true, templates: data.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.response?.data || err.message });
  }
});

// Tarea programada para reenviar mensajes no enviados
cron.schedule('0 8 * * *', async () => {
  try {
    console.log('Cron 8:00 reenvío de pendientes (sender=false)');
    const filePath = path.join(__dirname, 'messageRecords.json');
    if (!fs.existsSync(filePath)) return;

    const data = fs.readFileSync(filePath);
    const records = JSON.parse(data);
    const unsent = records.filter(r => !r.sender);

    let index = 0;
    const intervalId = setInterval(async () => {
      const slice = unsent.slice(index, index + 4);
      if (slice.length === 0) {
        clearInterval(intervalId);
        return;
      }
      for (const r of slice) {
        try {
          const resp = await sendWhatsAppCloud({ to: String(r.phone), message: r.message || null, imageUrl: r.imageUrl || null, videoUrl: r.videoUrl || null });
          if (resp.success) {
            updateMessageRecord(r.phone, r.message || null, r.imageUrl || null, r.videoUrl || null);
            console.log(`Reenviado a ${r.phone}`);
          } else {
            console.error(`Error reenviando a ${r.phone}:`, resp.error);
          }
        } catch (e) {
          console.error(`Excepción reenviando a ${r.phone}:`, e);
        }
      }
      index += 4;
    }, 60000);
  } catch (e) {
    console.error('Error en cron:', e);
  }
});

// Crear el directorio público si no existe
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'));
}

// Inicia Baileys solo si está habilitado explícitamente
if (process.env.USE_BAILEYS === 'true') {
  connectToWhatsApp();
}

const PORT = process.env.PORT || 3003;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});