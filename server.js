const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

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

connectWhatsApp();

// ================ OTP FUNCTIONS ================
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function validatePhone(phone) {
    return /^92[0-9]{10}$/.test(phone);
}

// ================ API ENDPOINTS ================

// 1. SEND OTP
app.post('/send-otp', async (req, res) => {
    try {
        const { phone, name } = req.body;

        if (!phone) {
            return res.status(400).json({ success: false, error: 'Phone required' });
        }

        if (!validatePhone(phone)) {
            return res.status(400).json({ success: false, error: 'Format: 923001234567' });
        }

        if (!isConnected || !sock) {
            return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
        }

        const otp = generateOTP();
        otpStore.set(phone, {
            otp,
            expiry: Date.now() + 300000,
            attempts: 0,
            name: name || 'User'
        });

        const jid = `${phone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { 
            text: `🔐 *${name || 'User'}*, your OTP is: *${otp}*\nValid for 5 minutes.` 
        });

        res.json({ success: true, message: 'OTP sent' });

    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed' });
    }
});

// 2. VERIFY OTP
app.post('/verify-otp', (req, res) => {
    const { phone, otp } = req.body;
    const record = otpStore.get(phone);

    if (!record) {
        return res.status(400).json({ success: false, error: 'No OTP found' });
    }

    if (Date.now() > record.expiry) {
        otpStore.delete(phone);
        return res.status(400).json({ success: false, error: 'OTP expired' });
    }

    if (record.attempts >= 3) {
        otpStore.delete(phone);
        return res.status(400).json({ success: false, error: 'Max attempts' });
    }

    record.attempts++;
    otpStore.set(phone, record);

    if (record.otp === otp) {
        otpStore.delete(phone);
        res.json({ success: true, message: 'Verified' });
    } else {
        res.status(400).json({ success: false, error: 'Invalid OTP', attemptsLeft: 3 - record.attempts });
    }
});

// 3. RESEND OTP
app.post('/resend-otp', async (req, res) => {
    const { phone } = req.body;
    const record = otpStore.get(phone);

    if (!record) {
        return res.status(400).json({ success: false, error: 'No OTP found' });
    }

    const newOTP = generateOTP();
    record.otp = newOTP;
    record.expiry = Date.now() + 300000;
    record.attempts = 0;
    otpStore.set(phone, record);

    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: `🔄 New OTP: *${newOTP}*` });

    res.json({ success: true, message: 'OTP resent' });
});

// 4. STATUS
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        qr: currentQR,
        activeOtps: otpStore.size
    });
});

// 5. QR
app.get('/qr', (req, res) => {
    if (currentQR) {
        res.json({ success: true, qr: currentQR });
    } else if (isConnected) {
        res.json({ success: true, message: 'Already connected' });
    } else {
        res.json({ success: false, message: 'No QR available' });
    }
});

// 6. HOME
app.get('/', (req, res) => {
    res.json({
        status: isConnected ? 'connected' : 'disconnected',
        endpoints: ['/send-otp', '/verify-otp', '/resend-otp', '/status', '/qr']
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
