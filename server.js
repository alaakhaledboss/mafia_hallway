const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const qrcode = require('qrcode-terminal');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

let players = []; // { id, name, role, isAlive }
let gameState = 'LOBBY'; // LOBBY, NIGHT_MAFIA, NIGHT_DOCTOR, NIGHT_RESULTS, DAY_DISCUSSION, DAY_VOTING, DAY_RESULTS
let nightActions = {
    mafiaKills: [],
    doctorHeal: null
};
let votes = {};

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.emit('state_update', { gameState, players: getSafePlayers() });

    socket.on('join_game', (nickname) => {
        let cleanName = nickname.trim() || `Player ${players.length + 1}`;
        players.push({
            id: socket.id,
            name: cleanName,
            role: null,
            isAlive: true
        });
        broadcastUpdate();
    });

    socket.on('start_game_config', (config) => {
        if (players.length < 3) return;
        
        assignRoles(config);
        gameState = 'NIGHT_MAFIA';
        nightActions = { mafiaKills: [], doctorHeal: null };
        
        broadcastUpdate();
        triggerNightPhase();
    });

    socket.on('mafia_action', (data) => {
        let player = players.find(p => p.id === socket.id);
        if (!player || player.role !== 'Mafia' || !player.isAlive) return;

        let target = players.find(p => p.id === data.targetId);
        if (!target || target.id === socket.id || target.role === 'Mafia' || !target.isAlive) return;

        if (nightActions.mafiaKills.some(k => k.mafiaId === socket.id)) return;

        nightActions.mafiaKills.push({ mafiaId: socket.id, mafiaName: player.name, targetId: data.targetId });
        
        let mafiaSockets = players.filter(p => p.role === 'Mafia' && p.isAlive);
        mafiaSockets.forEach(m => {
            io.to(m.id).emit('mafia_live_log', nightActions.mafiaKills);
        });

        if (nightActions.mafiaKills.length >= mafiaSockets.length) {
            gameState = 'NIGHT_DOCTOR';
            broadcastUpdate();
            triggerNightPhase();
        }
    });

    socket.on('doctor_action', (targetId) => {
        let player = players.find(p => p.id === socket.id);
        if (!player || player.role !== 'Doctor' || !player.isAlive) {
            resolveNight();
            return;
        }
        nightActions.doctorHeal = targetId;
        resolveNight();
    });

    socket.on('start_discussion', () => {
        gameState = 'DAY_DISCUSSION';
        broadcastUpdate();
        io.emit('phase_announcement', { title: 'مرحلة النقاش اليومي', desc: 'كل لاعب يأخذ دوره للتحدث (تمرير المايك)...' });
    });

    socket.on('start_voting', () => {
        gameState = 'DAY_VOTING';
        votes = {};
        broadcastUpdate();
        io.emit('trigger_vote_prompts', { players: players.filter(p => p.isAlive) });
    });

    socket.on('cast_vote', (targetId) => {
        let voter = players.find(p => p.id === socket.id);
        if (!voter || !voter.isAlive) return;

        votes[socket.id] = targetId;

        let livingPlayers = players.filter(p => p.isAlive);
        if (Object.keys(votes).length >= livingPlayers.length) {
            resolveVoting();
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        broadcastUpdate();
    });
});

function getSafePlayers() {
    return players.map(p => ({
        id: p.id,
        name: p.name,
        isAlive: p.isAlive
    }));
}

function broadcastUpdate() {
    io.emit('state_update', { gameState, players: getSafePlayers() });
}

function assignRoles(config) {
    let shuffled = [...players].sort(() => 0.5 - Math.random());
    let mafiaCount = parseInt(config.mafiaCount) || 1;
    let includeDoctor = config.includeDoctor;

    shuffled.forEach((p, index) => {
        let playerRef = players.find(x => x.id === p.id);
        if (index < mafiaCount) {
            playerRef.role = 'Mafia';
        } else if (includeDoctor && index === mafiaCount) {
            playerRef.role = 'Doctor';
        } else {
            playerRef.role = 'Citizen';
        }
    });

    players.forEach(p => {
        io.to(p.id).emit('your_role', { role: p.role });
    });
}

function triggerNightPhase() {
    io.emit('trigger_night_prompts', { gameState, players: players.filter(p => p.isAlive) });
}

function resolveNight() {
    gameState = 'NIGHT_RESULTS';
    let killedTargetId = nightActions.mafiaKills.length > 0 ? nightActions.mafiaKills[0].targetId : null;
    let healedTargetId = nightActions.doctorHeal;

    let resultMessage = '';
    let victim = players.find(p => p.id === killedTargetId);

    if (killedTargetId && killedTargetId === healedTargetId) {
        resultMessage = `عملية قتل فاشلة , تمت محاولة قتل ${victim ? victim.name : 'الشخص'} وتمت معالجته`;
    } else if (killedTargetId) {
        if (victim) victim.isAlive = false;
        resultMessage = `عملية قتل ناجحة !! تم تصفية ${victim ? victim.name : 'الضحية'}`;
    } else {
        resultMessage = `لم يحدث شيء في هذه الليلة.`;
    }

    io.emit('night_summary', { message: resultMessage });
    broadcastUpdate();
}

function resolveVoting() {
    gameState = 'DAY_RESULTS';
    
    let voteCounts = {};
    Object.values(votes).forEach(targetId => {
        voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    });

    let highestVotes = 0;
    let executedId = null;
    for (let [targetId, count] of Object.entries(voteCounts)) {
        if (count > highestVotes) {
            highestVotes = count;
            executedId = targetId;
        }
    }

    let victim = players.find(p => p.id === executedId);
    let message = '';
    if (victim) {
        victim.isAlive = false;
        message = `نتيجة التصويت: تم إعدام ${victim.name} بواسطة التصويت الجماعي!`;
    } else {
        message = `لم يتم إعدام أي شخص (تعادل في الأصوات).`;
    }

    io.emit('voting_summary', { message });
    broadcastUpdate();

    setTimeout(() => {
        gameState = 'NIGHT_MAFIA';
        nightActions = { mafiaKills: [], doctorHeal: null };
        votes = {};
        broadcastUpdate();
        triggerNightPhase();
    }, 6000);
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    let fallbackIP = 'localhost';

    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                if (net.address.startsWith('192.168.56.') || net.address.startsWith('26.')) {
                    continue;
                }
                if (net.address.startsWith('192.168.') || net.address.startsWith('10.') || net.address.startsWith('172.')) {
                    return net.address;
                }
                fallbackIP = net.address;
            }
        }
    }
    return fallbackIP;
}

const PORT = 3000;
server.listen(PORT, () => {
    const localUrl = `http://${getLocalIP()}:${PORT}`;
    console.log(`\n========================================`);
    console.log(` Host Dashboard: ${localUrl}`);
    console.log(` Player Join URL: ${localUrl}/player.html`);
    console.log(`========================================\n`);
    qrcode.generate(`${localUrl}/player.html`, { small: true });
});