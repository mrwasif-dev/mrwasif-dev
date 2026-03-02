const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');

dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/otp_system', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// OTP Schema
const otpSchema = new mongoose.Schema({
    phoneNumber: String,
    otp: String,
    expiresAt: Date,
    verified: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const OTP = mongoose.model('OTP', otpSchema);

// WhatsApp Connection
let sock = null;
let currentQR = null;
let connectionStatus = 'disconnected';

async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        logger: require('pino')({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        
        if (qr) {
            connectionStatus = 'connecting';
            // Generate QR code as data URL
            currentQR = await qrcode.toDataURL(qr);
        }
        
        if (connection === 'open') {
            connectionStatus = 'connected';
            currentQR = null;
            console.log('✅ WhatsApp Connected!');
        }
        
        if (connection === 'close') {
            connectionStatus = 'disconnected';
            currentQR = null;
            console.log('❌ Connection closed. Reconnecting...');
            connectWhatsApp();
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// Generate OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// API Routes
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

app.get('/whatsapp-status', (req, res) => {
    res.json({
        connected: connectionStatus === 'connected',
        status: connectionStatus,
        user: sock?.user || null
    });
});

app.get('/qr-code', (req, res) => {
    res.json({ qr: currentQR });
});

app.post('/refresh-qr', (req, res) => {
    // Force QR refresh by restarting connection
    if (sock) {
        sock.end();
    }
    connectWhatsApp();
    res.json({ success: true });
});

app.post('/disconnect-whatsapp', (req, res) => {
    if (sock) {
        sock.end();
        connectionStatus = 'disconnected';
        currentQR = null;
    }
    res.json({ success: true });
});

app.post('/send-otp', async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number required' });
        }
        
        if (connectionStatus !== 'connected') {
            return res.status(503).json({ error: 'WhatsApp not connected' });
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
        
        res.json({ success: true, message: 'OTP sent' });
    } catch (error) {
        console.error('Error sending OTP:', error);
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

app.post('/verify-otp', async (req, res) => {
    try {
        const { phoneNumber
