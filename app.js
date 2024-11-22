const express = require('express');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public')); 

let sock;
let currentQR = null;

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

// Route to get QR code status
app.get('/qr-status', (req, res) => {
    const qrExists = fs.existsSync(path.join(__dirname, 'public', 'qr-code.png'));
    res.json({ 
        qrAvailable: qrExists,
        qrPath: qrExists ? '/qr-code.png' : null 
    });
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'Se requieren tanto el teléfono como el mensaje' });
    }
    
    try {
        const formattedPhone = `${phone}@s.whatsapp.net`;
        await sock.sendMessage(formattedPhone, { text: message });
        res.json({ success: true, message: 'Mensaje enviado' });
    } catch (error) {
        console.error('Error al enviar mensaje:', error);
        res.status(500).json({ error: 'Error al enviar mensaje' });
    }
});

// Create public directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'));
}

connectToWhatsApp();

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});