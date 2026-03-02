const express = require('express');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const cors = require('cors');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const app = express();

// ==================== CONFIG ====================
const PORT = process.env.PORT || 3000;
const OTP_EXPIRY = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 3;

// ==================== MIDDLEWARE ====================
app.use(cors({ origin: '*' }));
app.use(express.json());

// ==================== STORES ====================
const otpStore = new Map();           // Temporary OTP storage
let whatsappClient = null;            // WhatsApp connection
let isWhatsAppConnected = false;      // Connection status
let latestQR = null;                  // Latest QR code

// ==================== WHATSAPP CLIENT ====================
async function initWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('./sessions');
        
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ['OTP API', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                latestQR = qr;
                console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP:\n');
                qrcode.generate(qr, { small: true });
                console.log('\n');
            }

            if (connection === 'open') {
                isWhatsAppConnected = true;
                latestQR = null;
                console.log('✅ WhatsApp connected successfully!');
            }

            if (connection === 'close') {
                isWhatsAppConnected = false;
                console.log('❌ Connection closed, reconnecting...');
                setTimeout(initWhatsApp, 5000);
            }
        });

        whatsappClient = sock;
    } catch (error) {
        console.error('WhatsApp init error:', error);
    }
}

// Start WhatsApp
initWhatsApp();

// ==================== HELPER FUNCTIONS ====================
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function validatePhone(phone) {
    // Format: 923001234567
    return /^92[0-9]{10}$/.test(phone);
}

function maskPhone(phone) {
    if (!phone || phone.length < 10) return phone;
    return phone.substring(0, 4) + '****' + phone.substring(phone.length - 4);
}

// ==================== API ENDPOINTS ====================

// 1. SEND OTP
app.post('/send-otp', async (req, res) => {
    try {
        const { phone, name } = req.body;

        // Validate
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

        if (!isWhatsAppConnected || !whatsappClient) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp not connected. Scan QR first.' 
            });
        }

        // Generate and store OTP
        const otp = generateOTP();
        otpStore.set(phone, {
            otp,
            expiry: Date.now() + OTP_EXPIRY,
            attempts: 0,
            name: name || 'User'
        });

        // Send via WhatsApp
        const jid = `${phone}@s.whatsapp.net`;
        const message = `🔐 *${name || 'User'}*, your verification code is: *${otp}*\n\nValid for 5 minutes.`;
        
        await whatsappClient.sendMessage(jid, { text: message });

        console.log(`✅ OTP sent to ${maskPhone(phone)}`);

        res.json({
            success: true,
            message: 'OTP sent successfully',
            phone: maskPhone(phone),
            expiresIn: 300
        });

    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to send OTP' 
        });
    }
});

// 2. VERIFY OTP
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

        if (!record) {
            return res.status(400).json({ 
                success: false, 
                error: 'No OTP found. Request new one.' 
            });
        }

        if (Date.now() > record.expiry) {
            otpStore.delete(phone);
            return res.status(400).json({ 
                success: false, 
                error: 'OTP expired' 
            });
        }

        if (record.attempts >= MAX_ATTEMPTS) {
            otpStore.delete(phone);
            return res.status(400).json({ 
                success: false, 
                error: 'Max attempts exceeded' 
            });
        }

        record.attempts++;
        otpStore.set(phone, record);

        if (record.otp === otp) {
            otpStore.delete(phone);
            console.log(`✅ Verified: ${maskPhone(phone)}`);
            res.json({ 
                success: true, 
                message: 'OTP verified successfully' 
            });
        } else {
            res.status(400).json({ 
                success: false, 
                error: 'Invalid OTP',
                attemptsLeft: MAX_ATTEMPTS - record.attempts
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

// 3. RESEND OTP
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
        record.expiry = Date.now() + OTP_EXPIRY;
        record.attempts = 0;
        otpStore.set(phone, record);

        // Send again
        const jid = `${phone}@s.whatsapp.net`;
        const message = `🔄 Resent OTP: *${newOTP}*\n\nValid for 5 minutes.`;
        await whatsappClient.sendMessage(jid, { text: message });

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

// 4. GET STATUS
app.get('/status', (req, res) => {
    res.json({
        success: true,
        whatsapp: isWhatsAppConnected ? 'connected' : 'disconnected',
        qr: latestQR,
        activeOtps: otpStore.size,
        uptime: process.uptime()
    });
});

// 5. GET QR (for web display)
app.get('/qr', (req, res) => {
    if (latestQR) {
        res.json({ success: true, qr: latestQR });
    } else {
        res.json({ 
            success: false, 
            message: isWhatsAppConnected ? 'Already connected' : 'No QR available' 
        });
    }
});

// 6. HOME
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp OTP API',
        version: '1.0',
        endpoints: [
            'POST /send-otp     - Send OTP',
            'POST /verify-otp   - Verify OTP',
            'POST /resend-otp   - Resend OTP',
            'GET  /status       - Check status',
            'GET  /qr           - Get QR code'
        ],
        status: isWhatsAppConnected ? '✅ WhatsApp connected' : '❌ WhatsApp disconnected'
    });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`\n🚀 OTP API Server running on port ${PORT}`);
    console.log(`📡 Base URL: http://localhost:${PORT}`);
    console.log(`\n📱 To connect WhatsApp:`);
    console.log(`1. Open http://localhost:${PORT}/qr in browser`);
    console.log(`2. Or check terminal for QR code\n`);
});
