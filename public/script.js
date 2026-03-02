// API Base URL
const API_BASE = window.location.origin;

// Global variables
let qrCheckInterval = null;
let isWhatsAppConnected = false;

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    checkServerStatus();
    checkWhatsAppStatus();
    loadRecentOTPs();
    
    // Start polling for QR code if not connected
    startQRPolling();
});

// Check server status
async function checkServerStatus() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();
        
        if (response.ok) {
            updateServerStatus('connected');
        } else {
            updateServerStatus('disconnected');
        }
    } catch (error) {
        updateServerStatus('disconnected');
    }
}

// Check WhatsApp status
async function checkWhatsAppStatus() {
    try {
        const response = await fetch(`${API_BASE}/whatsapp-status`);
        const data = await response.json();
        
        if (data.connected) {
            updateWhatsAppStatus('connected', data.user);
            isWhatsAppConnected = true;
        } else {
            updateWhatsAppStatus('disconnected');
            isWhatsAppConnected = false;
        }
    } catch (error) {
        updateWhatsAppStatus('disconnected');
    }
}

// Start polling for QR code
function startQRPolling() {
    if (qrCheckInterval) {
        clearInterval(qrCheckInterval);
    }
    
    qrCheckInterval = setInterval(async () => {
        if (!isWhatsAppConnected) {
            await checkQRCode();
        }
    }, 3000);
}

// Check for QR code
async function checkQRCode() {
    try {
        const response = await fetch(`${API_BASE}/qr-code`);
        const data = await response.json();
        
        if (data.qr) {
            displayQRCode(data.qr);
        }
    } catch (error) {
        console.error('Error checking QR:', error);
    }
}

// Display QR code
function displayQRCode(qrData) {
    const qrContainer = document.getElementById('qrContainer');
    
    // Clear previous content
    qrContainer.innerHTML = '';
    
    // Create QR code image
    const qrImage = document.createElement('img');
    qrImage.src = qrData;
    qrImage.alt = 'WhatsApp QR Code';
    qrImage.style.maxWidth = '200px';
    
    qrContainer.appendChild(qrImage);
    
    // Show instructions
    document.querySelector('.qr-instructions').style.display = 'block';
}

// Refresh QR code
async function refreshQR() {
    try {
        showToast('Refreshing QR code...');
        
        const response = await fetch(`${API_BASE}/refresh-qr`, {
            method: 'POST'
        });
        
        if (response.ok) {
            showToast('QR code refreshed successfully');
        }
    } catch (error) {
        showToast('Error refreshing QR code', 'error');
    }
}

// Disconnect WhatsApp
async function disconnectWhatsApp() {
    try {
        const response = await fetch(`${API_BASE}/disconnect-whatsapp`, {
            method: 'POST'
        });
        
        if (response.ok) {
            updateWhatsAppStatus('disconnected');
            showToast('WhatsApp disconnected successfully');
        }
    } catch (error) {
        showToast('Error disconnecting WhatsApp', 'error');
    }
}

// Send OTP
async function sendOTP() {
    const phoneNumber = document.getElementById('phoneNumber').value.trim();
    const sendBtn = document.getElementById('sendBtn');
    const sendResult = document.getElementById('sendResult');
    
    if (!phoneNumber) {
        showToast('Please enter phone number', 'error');
        return;
    }
    
    // Validate phone number
    if (!phoneNumber.match(/^\d{10,15}$/)) {
        showToast('Please enter a valid phone number', 'error');
        return;
    }
    
    // Disable button and show loading
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
    
    try {
        const response = await fetch(`${API_BASE}/send-otp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ phoneNumber })
        });
        
        const data = await response.json();
        
        sendResult.style.display = 'block';
        
        if (response.ok && data.success) {
            sendResult.className = 'result-box success';
            sendResult.innerHTML = `<i class="fas fa-check-circle"></i> OTP sent successfully! Expires in 5 minutes`;
            showToast('OTP sent successfully');
            
            // Clear phone number for verification
            document.getElementById('verifyPhone').value = phoneNumber;
        } else {
            sendResult.className = 'result-box error';
            sendResult.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${data.error || 'Failed to send OTP'}`;
        }
    } catch (error) {
        sendResult.style.display = 'block';
        sendResult.className = 'result-box error';
        sendResult.innerHTML = `<i class="fas fa-exclamation-circle"></i> Network error. Please try again.`;
    } finally {
        // Re-enable button
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Send OTP';
        
        // Refresh OTP list
        loadRecentOTPs();
    }
}

// Verify OTP
async function verifyOTP() {
    const phoneNumber = document.getElementById('verifyPhone').value.trim();
    const otpCode = document.getElementById('otpCode').value.trim();
    const verifyBtn = document.getElementById('verifyBtn');
    const verifyResult = document.getElementById('verifyResult');
    
    if (!phoneNumber || !otpCode) {
        showToast('Please enter both phone number and OTP', 'error');
        return;
    }
    
    if (otpCode.length !== 6 || !otpCode.match(/^\d+$/)) {
        showToast('Please enter a valid 6-digit OTP', 'error');
        return;
    }
    
    // Disable button and show loading
    verifyBtn.disabled = true;
    verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
    
    try {
        const response = await fetch(`${API_BASE}/verify-otp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ phoneNumber, otp: otpCode })
        });
        
        const data = await response.json();
        
        verifyResult.style.display = 'block';
        
        if (response.ok && data.success) {
            verifyResult.className = 'result-box success';
            verifyResult.innerHTML = `<i class="fas fa-check-circle"></i> OTP verified successfully!`;
            showToast('OTP verified successfully');
            
            // Clear OTP input
            document.getElementById('otpCode').value = '';
        } else {
            verifyResult.className = 'result-box error';
            verifyResult.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${data.error || 'Invalid OTP'}`;
        }
    } catch (error) {
        verifyResult.style.display = 'block';
        verifyResult.className = 'result-box error';
        verifyResult.innerHTML = `<i class="fas fa-exclamation-circle"></i> Network error. Please try again.`;
    } finally {
        // Re-enable button
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = '<i class="fas fa-check-circle"></i> Verify OTP';
        
        // Refresh OTP list
        loadRecentOTPs();
    }
}

// Load recent OTPs
async function loadRecentOTPs() {
    const tableBody = document.getElementById('otpTableBody');
    
    try {
        const response = await fetch(`${API_BASE}/recent-otps`);
        const data = await response.json();
        
        if (response.ok && data.otps) {
            if (data.otps.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="5" class="text-center">No OTPs found</td></tr>';
                return;
            }
            
            let html = '';
            data.otps.forEach(otp => {
                const status = getStatusBadge(otp);
                const expiresIn = getTimeRemaining(otp.expiresAt);
                
                html += `
                    <tr>
                        <td>${otp.phoneNumber}</td>
                        <td>****${otp.otp.slice(-2)}</td>
                        <td><span class="status-badge ${status.class}">${status.text}</span></td>
                        <td>${expiresIn}</td>
                        <td>
                            <button class="action-btn view" onclick="viewOTP('${otp._id}')">
                                <i class="fas fa-eye"></i>
                            </button>
                            <button class="action-btn delete" onclick="deleteOTP('${otp._id}')">
                                <i class="fas fa-trash"></i>
                            </button>
                        </td>
                    </tr>
                `;
            });
            
            tableBody.innerHTML = html;
        }
    } catch (error) {
        tableBody.innerHTML = '<tr><td colspan="5" class="text-center">Error loading OTPs</td></tr>';
    }
}

// Get status badge
function getStatusBadge(otp) {
    const now = new Date();
    const expiry = new Date(otp.expiresAt);
    
    if (otp.verified) {
        return { class: 'verified', text: 'Verified' };
    } else if (expiry < now) {
        return { class: 'expired', text: 'Expired' };
    } else {
        return { class: 'pending', text: 'Pending' };
    }
}

// Get time remaining
function getTimeRemaining(expiryDate) {
    const now = new Date();
    const expiry = new Date(expiryDate);
    const diff = expiry - now;
    
    if (diff <= 0) return 'Expired';
    
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    
    return `${minutes}m ${seconds}s`;
}

// View OTP details
async function viewOTP(id) {
    try {
        const response = await fetch(`${API_BASE}/otp/${id}`);
        const data = await response.json();
        
        if (response.ok) {
            alert(`OTP: ${data.otp.otp}\nPhone: ${data.otp.phoneNumber}\nStatus: ${data.otp.verified ? 'Verified' : 'Pending'}`);
        }
    } catch (error) {
        showToast('Error fetching OTP details', 'error');
    }
}

// Delete OTP
async function deleteOTP(id) {
    if (!confirm('Are you sure you want to delete this OTP?')) return;
    
    try {
        const response = await fetch(`${API_BASE}/otp/${id}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            showToast('OTP deleted successfully');
            loadRecentOTPs();
        }
    } catch (error) {
        showToast('Error deleting OTP', 'error');
    }
}

// Update server status
function updateServerStatus(status) {
    const statusElement = document.getElementById('serverStatus');
    statusElement.className = `status-value ${status}`;
    
    if (status === 'connected') {
        statusElement.innerHTML = '<i class="fas fa-circle"></i> Connected';
    } else {
        statusElement.innerHTML = '<i class="fas fa-circle"></i> Disconnected';
    }
}

// Update WhatsApp status
function updateWhatsAppStatus(status, user = null) {
    const statusElement = document.getElementById('whatsappStatus');
    const qrSection = document.getElementById('qrSection');
    const connectionDetails = document.getElementById('connectionDetails');
    
    statusElement.className = `status-value ${status}`;
    
    if (status === 'connected') {
        statusElement.innerHTML = '<i class="fas fa-circle"></i> Connected';
        
        // Show connection details
        qrSection.style.display = 'none';
        connectionDetails.style.display = 'block';
        
        // Update user info if available
        if (user) {
            document.getElementById('userName').textContent = user.name || 'WhatsApp User';
            document.getElementById('userPhone').textContent = user.phone || 'Connected';
        }
    } else if (status === 'connecting') {
        statusElement.innerHTML = '<i class="fas fa-circle"></i> Connecting...';
        qrSection.style.display = 'block';
        connectionDetails.style.display = 'none';
    } else {
        statusElement.innerHTML = '<i class="fas fa-circle"></i> Disconnected';
        qrSection.style.display = 'block';
        connectionDetails.style.display = 'none';
    }
}

// Show toast notification
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');
    
    toastMessage.textContent = message;
    toast.style.background = type === 'success' ? '#00b09b' : '#dc3545';
    
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}
