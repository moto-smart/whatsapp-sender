const express = require('express');
const multer = require('multer');
const upload = multer();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const Sms360Client = require('./sms360');

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
            currentQR = qr;
            try {
                // Guardar el código QR como imagen
                await qrcode.toFile(path.join(__dirname, 'public', 'qr-code.png'), qr);
            } catch (error) {
                console.error('Error al generar la imagen del código QR:', error);
            }
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
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
    console.log('Enviando mensaje:', req.body);
    const { phone, message, imageUrl, videoUrl, limitOfMessages } = req.body;

    // Validación básica
    if (!phone || (!message && !imageUrl && !videoUrl)) {
        return res.status(400).json({ error: 'Se requiere al menos un teléfono y un mensaje, imagen o video' });
    }

    // Validar que no se envíen ambos: imagen y video
    if (imageUrl && videoUrl) {
        return res.status(400).json({ error: 'Solo se puede enviar una imagen o un video, no ambos' });
    }

    // Contar mensajes enviados hoy
    const messagesSentToday = countMessagesSentToday();
    console.log('Mensajes enviados hoy:', messagesSentToday);
    console.log('Límite de mensajes:', limitOfMessages);

    if (messagesSentToday >= limitOfMessages) {
        saveMessageRecord(phone, false, message, imageUrl, videoUrl);
        return res.status(429).json({ error: 'Límite de mensajes diarios alcanzado' });
    }

    // Añadir mensaje a la cola
    messageQueue.push({ phone, message, imageUrl, videoUrl });
    saveMessageRecord(phone, true, message, imageUrl, videoUrl);
    res.json({ success: true, message: 'Mensaje en cola para ser enviado' });
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

// Procesamiento de la cola de mensajes
setInterval(async () => {
    const batch = messageQueue.splice(0, 4); // Procesar 4 mensajes a la vez
    for (const { phone, message, imageUrl, videoUrl } of batch) {
        try {
            const formattedPhone = `${phone}@s.whatsapp.net`;

            if (imageUrl) {
                // Enviar imagen
                const result = await sock.sendMessage(formattedPhone, {
                    image: { url: imageUrl },
                    caption: message || '' // Texto opcional junto a la imagen
                });

                if (result && result.key && result.key.id) {
                    updateMessageRecord(phone, message, imageUrl, null);
                    console.log(`Imagen enviada a ${phone}`);
                } else {
                    console.error(`Error al enviar imagen a ${phone}: Respuesta inesperada`, result);
                }
            } else if (videoUrl) {
                // Enviar video
                const result = await sock.sendMessage(formattedPhone, {
                    video: { url: videoUrl },
                    caption: message || '' // Texto opcional junto al video
                });

                if (result && result.key && result.key.id) {
                    updateMessageRecord(phone, message, null, videoUrl);
                    console.log(`Video enviado a ${phone}`);
                } else {
                    console.error(`Error al enviar video a ${phone}: Respuesta inesperada`, result);
                }
            } else {
                // Enviar mensaje de texto
                const result = await sock.sendMessage(formattedPhone, { text: message });

                if (result && result.key && result.key.id) {
                    updateMessageRecord(phone, message, null, null);
                    console.log(`Mensaje enviado a ${phone}`);
                } else {
                    console.error(`Error al enviar mensaje a ${phone}: Respuesta inesperada`, result);
                }
            }
        } catch (error) {
            console.error(`Error al enviar mensaje a ${phone}:`, error);
        }
    }
}, 60000); // 60000 ms = 1 minuto

// Tarea programada para reenviar mensajes no enviados
cron.schedule('0 8 * * *', async () => {
    console.log('Ejecutando tarea cron para reenviar mensajes no enviados');
    const filePath = path.join(__dirname, 'messageRecords.json');
    if (!fs.existsSync(filePath)) {
        return;
    }

    const data = fs.readFileSync(filePath);
    const records = JSON.parse(data);

    const unsentMessages = records.filter(record => !record.sender);
    let index = 0;

    const intervalId = setInterval(async () => {
        const batch = unsentMessages.slice(index, index + 4);
        if (batch.length === 0) {
            clearInterval(intervalId);
            return;
        }

        for (const record of batch) {
            try {
                const formattedPhone = `${record.phone}@s.whatsapp.net`;
                let result;

                if (record.imageUrl) {
                    result = await sock.sendMessage(formattedPhone, {
                        image: { url: record.imageUrl },
                        caption: record.message || ''
                    });
                } else if (record.videoUrl) {
                    result = await sock.sendMessage(formattedPhone, {
                        video: { url: record.videoUrl },
                        caption: record.message || ''
                    });
                } else {
                    result = await sock.sendMessage(formattedPhone, { text: record.message });
                }

                if (result && result.key && result.key.id) {
                    updateMessageRecord(record.phone, record.message, record.imageUrl, record.videoUrl);
                    console.log(`Mensaje reenviado a ${record.phone}`);
                } else {
                    console.error(`Error al reenviar mensaje a ${record.phone}: Respuesta inesperada`, result);
                }
            } catch (error) {
                console.error(`Error al reenviar mensaje a ${record.phone}:`, error);
            }
        }

        index += 4;
    }, 60000); // 60000 ms = 1 minuto
});

// Crear el directorio público si no existe
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'));
}

connectToWhatsApp();

const PORT = process.env.PORT || 3003;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});