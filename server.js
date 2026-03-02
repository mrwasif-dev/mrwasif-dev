const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const { Boom } = require('@hapi/boom');

dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// MongoDB Connection with error handling
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/otp_system', {
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
    createdAt: { type: Date, default: Date.now, expires: 3600 } // Auto delete after 1 hour
});

const OTP = mongoose.model('OTP', otpSchema);

// WhatsApp Connection
let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

async function connectWhatsApp() {
    try {
        console.log('🔄 Connecting to WhatsApp...');
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // Remove this line if you want
            browser: ['OTP System', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            generateHighQualityLinkPreview: false,
            shouldSyncHistoryMessage: false
        });

        // Handle connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            // Handle QR code
            if (qr) {
                console.log('📱 QR Code received');
                connectionStatus = 'connecting';
                try {
                    // Generate QR code as data URL
                    currentQR = await qrcode.toDataURL(qr);
                    console.log('✅ QR Code generated for scanning');
                } catch (err) {
                    console.error('❌ Error generating QR code:', err);
                }
            }
            
            // Handle connection status
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('❌ Connection closed due to:', lastDisconnect?.error?.message);
                
                if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    console.log(`🔄 Reconnecting... Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
                    connectionStatus = 'reconnecting';
                    currentQR = null;
                    setTimeout(connectWhatsApp, 5000); // Reconnect after 5 seconds
                } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.log('❌ Max reconnection attempts reached. Please restart the app.');
                    connectionStatus = 'failed';
                } else {
                    console.log('❌ Logged out. Please scan QR code again.');
                    connectionStatus = 'disconnected';
                    currentQR = null;
                    reconnectAttempts = 0;
                }
            }
            
            if (connection === 'open') {
                console.log('✅ WhatsApp Connected Successfully!');
                console.log(`👤 Logged in as: ${sock.user?.name || 'Unknown'}`);
                console.log(`📱 Phone: ${sock.user?.id || 'Unknown'}`);
                
                connectionStatus = 'connected';
                currentQR = null;
                reconnectAttempts = 0;
            }
        });

        // Handle credentials update
        sock.ev.on('creds.update', saveCreds);

        // Handle messages (optional - for debugging)
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            if (message.key && message.key.remoteJid) {
                console.log(`📨 Message received from: ${message.key.remoteJid}`);
            }
        });

    } catch (error) {
        console.error('❌ Fatal error in WhatsApp connection:', error);
        connectionStatus = 'error';
        
        // Attempt to reconnect after error
        setTimeout(connectWhatsApp, 10000);
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
        timestamp: new Date().toISOString(),
        whatsapp: connectionStatus
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
        res.json({ qr: currentQR, status: connectionStatus });
    } else {
        res.json({ 
            qr: null, 
            status: connectionStatus,
            message: connectionStatus === 'connected' ? 'Already connected' : 'No QR code available'
        });
    }
});

app.post('/refresh-qr', async (req, res) => {
    try {
        if (sock) {
            console.log('🔄 Ending current connection to refresh QR...');
            sock.end(new Error('Manual refresh'));
        }
        
        connectionStatus = 'disconnected';
        currentQR = null;
        reconnectAttempts = 0;
        
        // Small delay before reconnecting
        setTimeout(() => {
            connectWhatsApp();
        }, 2000);
        
        res.json({ success: true, message: 'Refreshing QR code...' });
    } catch (error) {
        console.error('❌ Error refreshing QR:', error);
        res.status(500).json({ error: 'Failed to refresh QR code' });
    }
});

app.post('/disconnect-whatsapp', (req, res) => {
    try {
        if (sock) {
            sock.end(new Error('User disconnected'));
            connectionStatus = 'disconnected';
            currentQR = null;
            reconnectAttempts = 0;
            console.log('🔌 WhatsApp disconnected by user');
        }
        res.json({ success: true, message: 'Disconnected successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to disconnect' });
    }
});

app.post('/send-otp', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number required' });
        }
        
        // Validate phone number
        if (!phoneNumber.match(/^\d{10,15}$/)) {
            return res.status(400).json({ error: 'Invalid phone number format' });
        }
        
        if (connectionStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp not connected. Current status: ' + connectionStatus });
        }
        
        if (!sock) {
            return res.status(503).json({ error: 'WhatsApp socket not initialized' });
        }
        
        const otp = generateOTP();
        
        // Save to database
        const otpRecord = new OTP({
            phoneNumber,
            otp,
            expiresAt: new Date(Date.now() + 5 * 60000) // 5 minutes
        });
        await otpRecord.save();
        
        // Send WhatsApp message
        const formattedNumber = `${phoneNumber}@s.whatsapp.net`;
        const message = `🔐 *Your OTP Code*\n\n` +
            `Code: *${otp}*\n\n` +
            `⏰ Valid for 5 minutes\n` +
            `🔒 Don't share this code with anyone`;
        
        await sock.sendMessage(formattedNumber, { text: message });
        
        console.log(`✅ OTP sent to ${phoneNumber}`);
        
        res.json({ 
            success: true, 
            message: 'OTP sent successfully',
            expiresIn: '5 minutes'
        });
    } catch (error) {
        console.error('❌ Error sending OTP:', error);
        res.status(500).json({ error: 'Failed to send OTP: ' + error.message });
    }
});

app.post('/verify-otp', async (req, res) => {
    try {
        const { phoneNumber, otp } = req.body;
        
        if (!phoneNumber || !otp) {
            return res.status(400).json({ error: 'Phone number and OTP required' });
        }
        
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
        
        console.log(`✅ OTP verified for ${phoneNumber}`);
        
        res.json({ success: true, message: 'OTP verified successfully' });
    } catch (error) {
        console.error('❌ Error verifying OTP:', error);
        res.status(500).json({ error: 'Verification failed: ' + error.message });
    }
});

app.get('/recent-otps', async (req, res) => {
    try {
        const otps = await OTP.find()
            .sort({ createdAt: -1 })
            .limit(10)
            .select('-__v');
        res.json({ otps });
    } catch (error) {
        console.error('❌ Error fetching OTPs:', error);
        res.json({ otps: [] });
    }
});

app.get('/otp/:id', async (req, res) => {
    try {
        const otp = await OTP.findById(req.params.id).select('-__v');
        if (!otp) {
            return res.status(404).json({ error: 'OTP not found' });
        }
        res.json({ otp });
    } catch (error) {
        res.status(500).json({ error: 'Error fetching OTP' });
    }
});

app.delete('/otp/:id', async (req, res) => {
    try {
        await OTP.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error deleting OTP' });
    }
});

// Serve HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Open http://localhost:${PORT} in your browser`);
    // Start WhatsApp connection
    connectWhatsApp();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('👋 SIGTERM received. Closing connections...');
    if (sock) {
        sock.end(new Error('Process terminated'));
    }
    mongoose.connection.close();
    process.exit(0);
});
