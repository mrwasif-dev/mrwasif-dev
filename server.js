const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OTP_EXPIRY = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

// ================ EPHEMERAL STORAGE FOR HEROKU ================
// Heroku filesystem is ephemeral, so we need to handle sessions carefully
const SESSION_DIR = './sessions';
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

app.use(cors({ origin: '*' }));
app.use(express.json());

const otpStore = new Map();
let whatsappClient = null;
let isWhatsAppConnected = false;
let latestQR = null;
let reconnectAttempts = 0;

// ================ IMPROVED WHATSAPP CLIENT ================
async function initWhatsApp() {
    try {
        console.log('🔄 Initializing WhatsApp...');
        
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true, // Direct terminal mein QR
            browser: ['OTP API', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                latestQR = qr;
                console.log('\n📱 SCAN QR CODE WITH WHATSAPP:\n');
                qrcode.generate(qr, { small: true });
                console.log('\n');
                reconnectAttempts = 0;
            }

            if (connection === 'open') {
                isWhatsAppConnected = true;
                latestQR = null;
                reconnectAttempts = 0;
                console.log('✅ WhatsApp Connected!');
            }

            if (connection === 'close') {
                isWhatsAppConnected = false;
                const shouldReconnect = (lastDisconnect.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                
                if (shouldReconnect) {
                    reconnectAttempts++;
                    const delay = Math.min(1000 * reconnectAttempts, 30000); // Exponential backoff
                    console.log(`❌ Connection closed. Reconnecting in ${delay/1000}s... (Attempt ${reconnectAttempts})`);
                    setTimeout(initWhatsApp, delay);
                } else {
                    console.log('❌ Logged out. Delete sessions folder and redeploy.');
                }
            }
        });

        // Keep connection alive
        sock.ev.on('messages.upsert', () => {});
        
        whatsappClient = sock;
    } catch (error) {
        console.error('WhatsApp init error:', error);
        setTimeout(initWhatsApp, 10000);
    }
}

// Start WhatsApp
initWhatsApp();

// ================ HELPER FUNCTIONS ================
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function validatePhone(phone) {
    return /^92[0-9]{10}$/.test(phone);
}

function maskPhone(phone) {
    if (!phone || phone.length < 10) return phone;
    return phone.substring(0, 4) + '****' + phone.substring(phone.length - 4);
}

// ================ API ENDPOINTS ================
app.post('/send-otp', async (req, res) => {
    try {
        const { phone, name } = req.body;

        if (!phone) {
            return res.status(400).json({ success: false, error: 'Phone required' });
        }

        if (!validatePhone(phone)) {
            return res.status(400).json({ success: false, error: 'Format: 923001234567' });
        }

        if (!isWhatsAppConnected || !whatsappClient) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp connecting. Wait and try again.',
                qr: latestQR ? 'Scan QR from /qr endpoint' : null
            });
        }

        const otp = generateOTP();
        otpStore.set(phone, {
            otp,
            expiry: Date.now() + OTP_EXPIRY,
            attempts: 0,
            name: name || 'User'
        });

        const jid = `${phone}@s.whatsapp.net`;
        const message = `🔐 *${name || 'User'}*, your verification code is: *${otp}*\n\nValid for 5 minutes.`;
        
        await whatsappClient.sendMessage(jid, { text: message });

        console.log(`✅ OTP sent to ${maskPhone(phone)}`);

        res.json({
            success: true,
            message: 'OTP sent',
            phone: maskPhone(phone),
            expiresIn: 300
        });

    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ success: false, error: 'Failed to send OTP' });
    }
});

app.post('/verify-otp', (req, res) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return res.status(400).json({ success: false, error: 'Phone and OTP required' });
        }

        const record = otpStore.get(phone);

        if (!record) {
            return res.status(400).json({ success: false, error: 'No OTP found' });
        }

        if (Date.now() > record.expiry) {
            otpStore.delete(phone);
            return res.status(400).json({ success: false, error: 'OTP expired' });
        }

        if (record.attempts >= MAX_ATTEMPTS) {
            otpStore.delete(phone);
            return res.status(400).json({ success: false, error: 'Max attempts exceeded' });
        }

        record.attempts++;
        otpStore.set(phone, record);

        if (record.otp === otp) {
            otpStore.delete(phone);
            console.log(`✅ Verified: ${maskPhone(phone)}`);
            res.json({ success: true, message: 'Verified' });
        } else {
            res.status(400).json({ 
                success: false, 
                error: 'Invalid OTP',
                attemptsLeft: MAX_ATTEMPTS - record.attempts
            });
        }

    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ success: false, error: 'Verification failed' });
    }
});

app.post('/resend-otp', async (req, res) => {
    try {
        const { phone } = req.body;

        const record = otpStore.get(phone);
        if (!record) {
            return res.status(400).json({ success: false, error: 'Request new OTP first' });
        }

        const newOTP = generateOTP();
        record.otp = newOTP;
        record.expiry = Date.now() + OTP_EXPIRY;
        record.attempts = 0;
        otpStore.set(phone, record);

        const jid = `${phone}@s.whatsapp.net`;
        const message = `🔄 Resent OTP: *${newOTP}*\n\nValid for 5 minutes.`;
        await whatsappClient.sendMessage(jid, { text: message });

        res.json({ success: true, message: 'OTP resent' });

    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to resend' });
    }
});

app.get('/status', (req, res) => {
    res.json({
        success: true,
        whatsapp: isWhatsAppConnected ? 'connected' : 'disconnecting',
        qr: latestQR,
        activeOtps: otpStore.size,
        reconnectAttempts: reconnectAttempts,
        uptime: process.uptime()
    });
});

app.get('/qr', (req, res) => {
    if (latestQR) {
        res.json({ success: true, qr: latestQR });
    } else if (isWhatsAppConnected) {
        res.json({ success: true, message: 'Already connected' });
    } else {
        res.json({ success: false, message: 'QR not available yet' });
    }
});

app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp OTP API',
        version: '2.0',
        status: isWhatsAppConnected ? '✅ Connected' : '❌ Disconnected',
        endpoints: [
            'POST /send-otp',
            'POST /verify-otp',
            'POST /resend-otp',
            'GET /status',
            'GET /qr'
        ]
    });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
});
