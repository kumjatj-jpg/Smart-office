const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/esp' });

const STATE_FILE = path.join(__dirname, 'state.json');

// สถานะหลักของระบบ
let appState = {
    relays: [false, false, false, false],
    autoMode: true
};

// โหลดสถานะที่ค้างไว้ล่าสุดเมื่อ Server เริ่มทำงาน
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            if (Array.isArray(parsed.relays) && parsed.relays.length === 4) {
                appState.relays = parsed.relays;
            }
            if (typeof parsed.autoMode === 'boolean') {
                appState.autoMode = parsed.autoMode;
            }
        }
    } catch (err) {
        console.error('Load state error:', err);
    }
}

// บันทึกสถานะทุกครั้งที่กดเปลี่ยนค่า
function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(appState, null, 2));
    } catch (err) {
        console.error('Save state error:', err);
    }
}

loadState();
app.use(express.static(path.join(__dirname, 'public')));

// ตรวจสอบตารางเวลา (จะทำงานเฉพาะเมื่อ autoMode เป็น true เท่านั้น)
function checkAutoSchedule() {
    if (!appState.autoMode) return;

    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const thTime = new Date(utc + (3600000 * 7));
    const totalMinutes = thTime.getHours() * 60 + thTime.getMinutes();

    const air1 = (totalMinutes >= 480 && totalMinutes < 525) ||
                 (totalMinutes >= 600 && totalMinutes < 645) ||
                 (totalMinutes >= 690 && totalMinutes < 735) ||
                 (totalMinutes >= 795 && totalMinutes < 840) ||
                 (totalMinutes >= 885 && totalMinutes < 930);

    const air2 = (totalMinutes >= 540 && totalMinutes < 585) ||
                 (totalMinutes >= 660 && totalMinutes < 705) ||
                 (totalMinutes >= 765 && totalMinutes < 810) ||
                 (totalMinutes >= 855 && totalMinutes < 900) ||
                 (totalMinutes >= 930 && totalMinutes < 960);

    let isChanged = false;
    if (appState.relays[0] !== air1) { appState.relays[0] = air1; isChanged = true; }
    if (appState.relays[1] !== air2) { appState.relays[1] = air2; isChanged = true; }

    if (isChanged) {
        saveState();
        broadcastState();
    }
}

setInterval(checkAutoSchedule, 1000);

wss.on('connection', (ws) => {
    // ส่งสถานะล่าสุดให้ทั้งหน้าเว็บและ ESP32 ทันทีที่เชื่อมต่อ
    ws.send(JSON.stringify({ 
        type: 'INIT_STATE', 
        relays: appState.relays, 
        autoMode: appState.autoMode 
    }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // จุดแก้สำคัญ: เมื่อ ESP32 ต่อเข้ามา ห้ามเอา data.relays จากบอร์ดมาทับ Server
            // ให้ Server ส่งสถานะล่าสุดกลับไปสั่งให้บอร์ดทำงานตามแทน
            if (data.type === 'ESP_CONNECT') {
                if (appState.autoMode) checkAutoSchedule();
                ws.send(JSON.stringify({ 
                    type: 'INIT_STATE', 
                    relays: appState.relays, 
                    autoMode: appState.autoMode 
                }));
                return;
            }

            // ควบคุมรายช่อง
            if (data.type === 'CONTROL') {
                const { ch, state } = data;
                if (ch >= 0 && ch < 4) {
                    appState.relays[ch] = Boolean(state);
                    saveState();
                    broadcastState();
                }
            } 
            // ควบคุมทั้งหมด
            else if (data.type === 'CONTROL_ALL') {
                appState.relays = appState.relays.map(() => Boolean(data.state));
                saveState();
                broadcastState();
            }
            // สลับโหมด Auto / Manual (เปลี่ยนได้เฉพาะเมื่อผู้ใช้กดปุ่มนี้เท่านั้น)
            else if (data.type === 'TOGGLE_AUTO') {
                appState.autoMode = Boolean(data.state);
                if (appState.autoMode) checkAutoSchedule();
                saveState();
                broadcastState();
            }
        } catch (e) {
            console.error('JSON Parse Error:', message);
        }
    });
});

function broadcastState() {
    const payload = JSON.stringify({ 
        type: 'INIT_STATE', 
        relays: appState.relays, 
        autoMode: appState.autoMode 
    });
    
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Smart Office Server running on port ${PORT}`);
});
