const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const pino = require('pino');

dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('✅ MongoDB Connected');
}).catch(err => {
    console.error('❌ MongoDB Connection Error:', err);
});

// OTP Schema
const otpSchema = new mongoose.Schema({
    phoneNumber: String,
    otp: String,
    expiresAt: Date,
    verified: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, expires: 3600 }
});

const OTP = mongoose.model('OTP', otpSchema);

// WhatsApp Connection
let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

// Create auth directory if it doesn't exist
const AUTH_DIR = path.join(__dirname, 'auth_info');
if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function connectWhatsApp() {
    try {
        console.log('🔄 Connecting to WhatsApp...');
        
        // Clear old QR
        currentQR = null;
        
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        
        // Create socket with proper configuration for Heroku
        sock = makeWASocket({
            auth: state,
            browser: ['OTP System', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            shouldSyncHistoryMessage: false,
            logger: pino({ level: 'silent' }), // Reduce logs
            printQRInTerminal: false,
            defaultQueryTimeoutMs: 10000, // 10 seconds timeout
            keepAliveIntervalMs: 10000, // 10 seconds keep alive
            retryRequestDelayMs: 1000
        });

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log('📱 QR Code generated');
                connectionStatus = 'connecting';
                try {
                    // Generate QR as data URL
                    currentQR = await qrcode.toDataURL(qr, {
                        width: 300,
                        margin: 2,
                        color: {
                            dark: '#000000',
                            light: '#ffffff'
                        }
                    });
                    console.log('✅ QR Code ready for scanning');
                } catch (err) {
                    console.error('❌ Error generating QR:', err);
                }
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log('❌ Connection closed. Status code:', statusCode);
                console.log('Error details:', lastDisconnect?.error?.message);
                
                if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    console.log(`🔄 Reconnecting... Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
                    connectionStatus = 'reconnecting';
                    currentQR = null;
                    
                    // Wait before reconnecting
                    setTimeout(connectWhatsApp, 5000 * reconnectAttempts);
                } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.log('❌ Max reconnection attempts reached');
                    connectionStatus = 'failed';
                    currentQR = null;
                    
                    // Reset after 5 minutes
                    setTimeout(() => {
                        reconnectAttempts = 0;
                        connectionStatus = 'disconnected';
                    }, 300000);
                } else {
                    console.log('❌ Logged out. Please scan QR again.');
                    connectionStatus = 'disconnected';
                    currentQR = null;
                    reconnectAttempts = 0;
                    
                    // Clear auth folder on logout
                    try {
                        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                        fs.mkdirSync(AUTH_DIR, { recursive: true });
                    } catch (e) {
                        console.log('Error clearing auth folder:', e);
                    }
                }
            }
            
            if (connection === 'open') {
                console.log('✅ WhatsApp Connected!');
                console.log(`👤 User: ${sock.user?.name || 'Unknown'}`);
                connectionStatus = 'connected';
                currentQR = null;
                reconnectAttempts = 0;
            }
        });

        // Handle credentials update
        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        console.error('❌ Fatal error:', error);
        connectionStatus = 'error';
        
        // Try to reconnect after error
        setTimeout(connectWhatsApp, 30000);
    }
}

// Generate OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// API Routes
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        whatsapp: connectionStatus,
        time: new Date().toISOString()
    });
});

app.get('/whatsapp-status', (req, res) => {
    res.json({
        connected: connectionStatus === 'connected',
        status: connectionStatus,
        user: sock?.user ? {
            name: sock.user.name || 'Unknown',
            id: sock.user.id || 'Unknown'
        } : null
    });
});

app.get('/qr-code', (req, res) => {
    if (currentQR) {
        res.json({ 
            qr: currentQR, 
            status: connectionStatus,
            message: 'Scan with WhatsApp'
        });
    } else {
        res.json({ 
            qr: null, 
            status: connectionStatus,
            message: connectionStatus === 'connected' ? 'Already connected' : 'No QR available'
        });
    }
});

app.post('/refresh-qr', async (req, res) => {
    try {
        if (sock) {
            sock.end(new Error('Manual refresh'));
        }
        
        connectionStatus = 'disconnected';
        currentQR = null;
        reconnectAttempts = 0;
        
        // Clear auth folder
        try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        } catch (e) {}
        
        // Reconnect
        setTimeout(connectWhatsApp, 2000);
        
        res.json({ success: true, message: 'Refreshing QR...' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to refresh' });
    }
});

app.post('/send-otp', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number required' });
        }
        
        if (!phoneNumber.match(/^\d{10,15}$/)) {
            return res.status(400).json({ error: 'Invalid phone number' });
        }
        
        if (connectionStatus !== 'connected' || !sock) {
            return res.status(503).json({ 
                error: 'WhatsApp not connected. Status: ' + connectionStatus 
            });
        }
        
        const otp = generateOTP();
        
        // Save to database
        const otpRecord = new OTP({
            phoneNumber,
            otp,
            expiresAt: new Date(Date.now() + 5 * 60000)
        });
        await otpRecord.save();
        
        // Send WhatsApp message
        const formattedNumber = `${phoneNumber}@s.whatsapp.net`;
        const message = `🔐 *Your OTP Code*\n\n` +
            `Code: *${otp}*\n\n` +
            `⏰ Valid for 5 minutes\n` +
            `🔒 Don't share this code`;
        
        await sock.sendMessage(formattedNumber, { text: message });
        
        console.log(`✅ OTP sent to ${phoneNumber}`);
        
        res.json({ 
            success: true, 
            message: 'OTP sent',
            expiresIn: '5 minutes'
        });
    } catch (error) {
        console.error('❌ Error sending OTP:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/verify-otp', async (req, res) => {
    try {
        const { phoneNumber, otp } = req.body;
        
        const otpRecord = await OTP.findOne({
            phoneNumber,
            otp,
            verified: false,
            expiresAt: { $gt: new Date() }
        });
        
        if (!otpRecord) {
            return res.status(400).json({ error: 'Invalid or expired OTP' });
        }
        
        otpRecord.verified = true;
        await otpRecord.save();
        
        res.json({ success: true, message: 'OTP verified' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/recent-otps', async (req, res) => {
    try {
        const otps = await OTP.find()
            .sort({ createdAt: -1 })
            .limit(10);
        res.json({ otps });
    } catch (error) {
        res.json({ otps: [] });
    }
});

// Serve HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Open browser and connect WhatsApp`);
    
    // Start WhatsApp connection
    setTimeout(connectWhatsApp, 3000);
});
