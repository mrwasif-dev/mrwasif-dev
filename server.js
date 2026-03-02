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
const otpStore = new Map();  // OTP store karo
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

// ================ OTP FUNCTIONS ================
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function validatePhone(phone) {
    return /^92[0-9]{10}$/.test(phone);
}

// ================ API ENDPOINTS ================

/**
 * 1. SEND OTP - WhatsApp par OTP bhejo
 * POST /send-otp
 * Body: { phone: "923001234567", name: "User" }
 */
app.post('/send-otp', async (req, res) => {
    try {
        const { phone, name } = req.body;

        // Validation
        if (!phone) {
            return res.status(400).json({ 
                success: false, 
                error: 'Phone number required' 
            });
        }

        if (!validatePhone(phone)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid format. Use: 923001234567' 
            });
        }

        if (!isConnected || !sock) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp not connected. Scan QR first.' 
            });
        }

        // Generate OTP
        const otp = generateOTP();
        const expiry = Date.now() + 5 * 60 * 1000; // 5 minutes

        // Store OTP
        otpStore.set(phone, {
            otp: otp,
            expiry: expiry,
            attempts: 0,
            name: name || 'User'
        });

        // Send via WhatsApp
        const jid = `${phone}@s.whatsapp.net`;
        const message = `🔐 *${name || 'User'}*, your verification code is:\n\n*${otp}*\n\nThis code will expire in 5 minutes.`;
        
        await sock.sendMessage(jid, { text: message });

        console.log(`✅ OTP sent to ${phone.substring(0, 4)}****${phone.substring(phone.length - 4)}`);

        // Success response (OTP nahi bhej rahe response mein)
        res.json({ 
            success: true, 
            message: 'OTP sent successfully',
            expiresIn: 300 // seconds
        });

    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send OTP' 
        });
    }
});

/**
 * 2. VERIFY OTP - OTP check karo
 * POST /verify-otp
 * Body: { phone: "923001234567", otp: "123456" }
 */
app.post('/verify-otp', (req, res) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return res.status(400).json({ 
                success: false, 
                error: 'Phone and OTP required' 
            });
        }

        const record = otpStore.get(phone);

        // Check if OTP exists
        if (!record) {
            return res.status(400).json({ 
                success: false, 
                error: 'No OTP found. Request new one.' 
            });
        }

        // Check expiry
        if (Date.now() > record.expiry) {
            otpStore.delete(phone);
            return res.status(400).json({ 
                success: false, 
                error: 'OTP expired' 
            });
        }

        // Check attempts
        if (record.attempts >= 3) {
            otpStore.delete(phone);
            return res.status(400).json({ 
                success: false, 
                error: 'Maximum attempts exceeded' 
            });
        }

        // Increment attempts
        record.attempts++;
        otpStore.set(phone, record);

        // Verify OTP
        if (record.otp === otp) {
            otpStore.delete(phone); // OTP verify hone ke baad delete
            console.log(`✅ Verified: ${phone.substring(0, 4)}****${phone.substring(phone.length - 4)}`);
            res.json({ 
                success: true, 
                message: 'OTP verified successfully' 
            });
        } else {
            res.status(400).json({ 
                success: false, 
                error: 'Invalid OTP',
                attemptsLeft: 3 - record.attempts
            });
        }

    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Verification failed' 
        });
    }
});

/**
 * 3. RESEND OTP - Dobara OTP bhejo
 * POST /resend-otp
 * Body: { phone: "923001234567" }
 */
app.post('/resend-otp', async (req, res) => {
    try {
        const { phone } = req.body;

        const record = otpStore.get(phone);
        if (!record) {
            return res.status(400).json({ 
                success: false, 
                error: 'Request new OTP first' 
            });
        }

        // Generate new OTP
        const newOTP = generateOTP();
        record.otp = newOTP;
        record.expiry = Date.now() + 5 * 60 * 1000;
        record.attempts = 0;
        otpStore.set(phone, record);

        // Send via WhatsApp
        const jid = `${phone}@s.whatsapp.net`;
        const message = `🔄 Resent OTP: *${newOTP}*\n\nValid for 5 minutes.`;
        await sock.sendMessage(jid, { text: message });

        res.json({ 
            success: true, 
            message: 'OTP resent' 
        });

    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to resend' 
        });
    }
});

/**
 * 4. STATUS - Connection status check
 * GET /status
 */
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        qr: currentQR,
        activeOtps: otpStore.size,
        uptime: process.uptime()
    });
});

/**
 * 5. QR CODE - Get QR for scanning
 * GET /qr
 */
app.get('/qr', (req, res) => {
    if (currentQR) {
        res.json({ success: true, qr: currentQR });
    } else if (isConnected) {
        res.json({ success: true, message: 'Already connected' });
    } else {
        res.json({ success: false, message: 'QR not available' });
    }
});

/**
 * 6. HOME - API info
 * GET /
 */
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp OTP API',
        version: '2.0',
        status: isConnected ? '✅ Connected' : '❌ Disconnected',
        endpoints: {
            'POST /send-otp': 'Send OTP to WhatsApp',
            'POST /verify-otp': 'Verify OTP',
            'POST /resend-otp': 'Resend OTP',
            'GET /status': 'Check connection',
            'GET /qr': 'Get QR code'
        }
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 OTP API Server running on port ${PORT}`);
    console.log(`📱 WhatsApp status: ${isConnected ? 'Connected' : 'Disconnected'}`);
});
