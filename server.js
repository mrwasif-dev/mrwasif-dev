const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ================ MIDDLEWARE ================
app.use(cors({ origin: '*' }));
app.use(express.json());

// ================ STORES ================
const otpStore = new Map();
let sock = null;
let isConnected = false;
let currentQR = null;

// ================ WHATSAPP CLIENT ================
async function connectWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./sessions');
        
        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: ['OTP API', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                currentQR = qr;
                console.log('\n📱 SCAN QR CODE:\n');
                qrcode.generate(qr, { small: true });
                console.log('\n');
            }

            if (connection === 'open') {
                isConnected = true;
                currentQR = null;
                console.log('✅ WhatsApp Connected!');
            }

            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = (lastDisconnect.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting...');
                    setTimeout(connectWhatsApp, 3000);
                }
            }
        });

    } catch (error) {
        console.error('Connection error:', error);
        setTimeout(connectWhatsApp, 5000);
    }
}

// Start connection
connectWhatsApp();

// ================ API ENDPOINTS ================

// 1. Send OTP
app.post('/send-otp', async (req, res) => {
    try {
        const { phone, name } = req.body;

        if (!phone) {
            return res.status(400).json({ error: 'Phone required' });
        }

        if (!isConnected) {
            return res.status(503).json({ error: 'WhatsApp not connected' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        
        otpStore.set(phone, {
            otp,
            expiry: Date.now() + 300000,
            attempts: 0
        });

        const jid = `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { 
            text: `🔐 Your OTP is: *${otp}*\nValid for 5 minutes.` 
        });

        res.json({ success: true });

    } catch (error) {
        res.status(500).json({ error: 'Failed' });
    }
});

// 2. Verify OTP
app.post('/verify-otp', (req, res) => {
    const { phone, otp } = req.body;
    const record = otpStore.get(phone);

    if (!record) {
        return res.status(400).json({ error: 'No OTP' });
    }

    if (Date.now() > record.expiry) {
        otpStore.delete(phone);
        return res.status(400).json({ error: 'Expired' });
    }

    if (record.otp === otp) {
        otpStore.delete(phone);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'Invalid' });
    }
});

// 3. Status
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        qr: currentQR,
        active: otpStore.size
    });
});

// 4. QR API
app.get('/qr', (req, res) => {
    if (currentQR) {
        res.json({ success: true, qr: currentQR });
    } else {
        res.json({ success: false, message: isConnected ? 'Connected' : 'No QR' });
    }
});

// 5. Home
app.get('/', (req, res) => {
    res.json({
        status: isConnected ? '✅ Connected' : '❌ Disconnected',
        endpoints: ['/send-otp', '/verify-otp', '/status', '/qr']
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server on port ${PORT}`);
});
