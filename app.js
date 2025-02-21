const express = require('express');
const multer = require('multer');
const upload = multer();
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.static('public'));

let sock;
let currentQR = null;
let messageQueue = [];

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        generateHighQualityLinkPreview: true
    })
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if(qr) {
            currentQR = qr;
            try {
                // Save QR code as an image file
                await qrcode.toFile(path.join(__dirname, 'public', 'qr-code.png'), qr);
            } catch (error) {
                console.error('Error generating QR code image:', error);
            }
        }
        
        if(connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut
            if(shouldReconnect) {
                connectToWhatsApp()
            }
        } else if(connection === 'open') {
            console.log('Conexión establecida')
            currentQR = null;
            // Remove QR code image if exists
            const qrPath = path.join(__dirname, 'public', 'qr-code.png');
            if (fs.existsSync(qrPath)) {
                fs.unlinkSync(qrPath);
            }
        }
    })
    
    sock.ev.on('creds.update', saveCreds)
}

// Function to save message record
function saveMessageRecord(phone, sender, message) {
    const record = {
        phone,
        timestamp: new Date().toISOString(),
        sender,
        message
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

// Function to count messages sent today
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

// Function to update message record
function updateMessageRecord(phone, message) {
    const filePath = path.join(__dirname, 'messageRecords.json');
    if (!fs.existsSync(filePath)) {
        return;
    }

    const data = fs.readFileSync(filePath);
    let records = JSON.parse(data);

    records = records.map(record => {
        if (record.phone === phone && record.message === message && !record.sender) {
            record.sender = true;
        }
        return record;
    });

    fs.writeFileSync(filePath, JSON.stringify(records, null, 2));
}

// Route to get QR code status
app.get('/qr-status', (req, res) => {
    const qrExists = fs.existsSync(path.join(__dirname, 'public', 'qr-code.png'));
    res.json({ 
        qrAvailable: qrExists,
        qrPath: qrExists ? '/qr-code.png' : null 
    });
});

app.post('/send-message', upload.none(), async (req, res) => {
    console.log(req)
    console.log('Enviando mensaje:', req.body);
    const { phone, message, limitOfMessages } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'Se requieren tanto el teléfono como el mensaje' });
    }

    const messagesSentToday = countMessagesSentToday();
    console.log('Mensajes enviados hoy:', messagesSentToday);
    console.log('Límite de mensajes:', limitOfMessages);
    console.log((messagesSentToday >= limitOfMessages) )
    if (messagesSentToday >= limitOfMessages) {
        saveMessageRecord(phone, false, message);
        return res.status(429).json({ error: 'Límite de mensajes diarios alcanzado' });
    }
    
    messageQueue.push({ phone, message });
    saveMessageRecord(phone, true, message);
    res.json({ success: true, message: 'Mensaje en cola para ser enviado' });
});

// Create public directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'));
}

connectToWhatsApp();

const PORT = process.env.PORT || 3003;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});

// Process message queue in batches of 4 every minute
setInterval(async () => {
    const batch = messageQueue.splice(0, 4);
    for (const { phone, message } of batch) {
        try {
            const formattedPhone = `${phone}@s.whatsapp.net`;
            const result = await sock.sendMessage(formattedPhone, { text: message });
            if (result && result.key && result.key.id) {
                updateMessageRecord(phone, message);
                console.log(`Mensaje enviado a ${phone}`);
            } else {
                console.error(`Error al enviar mensaje a ${phone}: Respuesta inesperada`, result);
            }
        } catch (error) {
            console.error(`Error al enviar mensaje a ${phone}:`, error);
        }
    }
}, 60000); // 60000 ms = 1 minuto

// Cron job to resend messages with sender=false at 8 AM every day
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
                const result = await sock.sendMessage(formattedPhone, { text: record.message });
                if (result && result.key && result.key.id) {
                    updateMessageRecord(record.phone, record.message);
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