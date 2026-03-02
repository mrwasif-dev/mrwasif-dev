const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ================ MIDDLEWARE ================
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('public'));

// ================ STORES ================
const otpStore = new Map();
let sock = null;
let isConnected = false;
let currentQR = null;
let reconnectAttempts = 0;

// ================ SESSIONS FOLDER ================
const SESSION_DIR = './sessions';
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// ================ WHATSAPP CLIENT ================
async function connectWhatsApp() {
    try {
        console.log('🔄 Starting WhatsApp connection...');
        
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        
        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: ['OTP System', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                currentQR = qr;
                reconnectAttempts = 0;
                console.log('\n📱 ========== SCAN THIS QR CODE ==========\n');
                qrcode.generate(qr, { small: true });
                console.log('\n📱 ======================================\n');
                console.log('👉 Open WhatsApp > Linked Devices > Scan QR\n');
            }

            if (connection === 'open') {
                isConnected = true;
                currentQR = null;
                reconnectAttempts = 0;
                console.log('✅ WhatsApp Connected Successfully!');
                console.log('🚀 OTP System is ready to use');
            }

            if (connection === 'close') {
                isConnected = false;
                const shouldReconnect = (lastDisconnect.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                    : true;
                
                if (shouldReconnect) {
                    reconnectAttempts++;
                    const delay = Math.min(1000 * reconnectAttempts, 30000);
                    console.log(`❌ Disconnected. Reconnecting in ${delay/1000}s... (Attempt ${reconnectAttempts})`);
                    setTimeout(connectWhatsApp, delay);
                } else {
                    console.log('❌ Logged out. Delete sessions folder and redeploy.');
                }
            }
        });

    } catch (error) {
        console.error('Connection error:', error);
        setTimeout(connectWhatsApp, 5000);
    }
}

// Start WhatsApp
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
app.post('/api/send-otp', async (req, res) => {
    try {
        const { phone, name } = req.body;

        if (!phone) {
            return res.status(400).json({ success: false, error: 'Phone required' });
        }

        if (!validatePhone(phone)) {
            return res.status(400).json({ success: false, error: 'Format: 923001234567' });
        }

        if (!isConnected || !sock) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp not connected. Scan QR first.' 
            });
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
            text: `🔐 *${name || 'User'}*, your verification code is: *${otp}*\n\nValid for 5 minutes.` 
        });

        console.log(`✅ OTP sent to ${phone.substring(0,4)}****${phone.substring(phone.length-4)}`);
        res.json({ success: true, message: 'OTP sent successfully' });

    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ success: false, error: 'Failed to send OTP' });
    }
});

// 2. VERIFY OTP
app.post('/api/verify-otp', (req, res) => {
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
        return res.status(400).json({ success: false, error: 'Max attempts exceeded' });
    }

    record.attempts++;
    otpStore.set(phone, record);

    if (record.otp === otp) {
        otpStore.delete(phone);
        res.json({ success: true, message: 'OTP verified successfully' });
    } else {
        res.status(400).json({ 
            success: false, 
            error: 'Invalid OTP', 
            attemptsLeft: 3 - record.attempts 
        });
    }
});

// 3. RESEND OTP
app.post('/api/resend-otp', async (req, res) => {
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
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        qr: currentQR,
        activeOtps: otpStore.size,
        reconnectAttempts: reconnectAttempts
    });
});

// 5. QR
app.get('/api/qr', (req, res) => {
    if (currentQR) {
        res.json({ success: true, qr: currentQR });
    } else if (isConnected) {
        res.json({ success: true, message: 'Already connected', connected: true });
    } else {
        res.json({ success: false, message: 'QR not available yet. Check logs or wait...' });
    }
});

// ================ MAIN PAGE ================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚀 ==================================`);
    console.log(`🚀 OTP System running on port ${PORT}`);
    console.log(`🚀 Open: https://optosystm-2cfc9fe49097.herokuapp.com`);
    console.log(`🚀 ==================================\n`);
});
