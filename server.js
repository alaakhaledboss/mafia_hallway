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
let gameState = 'LOBBY'; 
let nightActions = {
    mafiaKills: [],
    doctorHeal: null
};
let votes = {}; // socketId -> targetId
let lockedVotes = {}; // socketId -> boolean
let currentSpeakerIndex = 0;

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.emit('state_update', { gameState, players: getSafePlayers() });

    socket.on('join_game', (nickname) => {
        if (gameState !== 'LOBBY') return;
        
        // Remove existing player entry for this socket if any exists
        players = players.filter(p => p.id !== socket.id);

        let cleanName = nickname.trim() || `Player ${players.length + 1}`;
        players.push({
            id: socket.id,
            name: cleanName,
            role: null,
            isAlive: true
        });
        
        // Explicitly emit join_success to hide the player join form
        socket.emit('join_success');
        broadcastUpdate();
    });

    socket.on('start_game_config', (config) => {
        if (players.length < 3) return;
        
        assignRoles(config);
        gameState = 'NIGHT_MAFIA';
        nightActions = { mafiaKills: [], doctorHeal: null };
        
        broadcastUpdate();
        triggerNightMafia();
    });

    socket.on('reset_to_lobby', () => {
        gameState = 'LOBBY';
        players.forEach(p => {
            p.role = null;
            p.isAlive = true;
        });
        nightActions = { mafiaKills: [], doctorHeal: null };
        votes = {};
        lockedVotes = {};
        currentSpeakerIndex = 0;
        broadcastUpdate();
        io.emit('reset_client');
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
            let doctorAlive = players.some(p => p.role === 'Doctor' && p.isAlive);
            if (doctorAlive) {
                gameState = 'NIGHT_DOCTOR';
                broadcastUpdate();
                triggerNightDoctor();
            } else {
                resolveNight();
            }
        }
    });

    socket.on('doctor_action', (targetId) => {
        let player = players.find(p => p.id === socket.id);
        if (!player || player.role !== 'Doctor' || !player.isAlive) return;
        nightActions.doctorHeal = targetId;
        resolveNight();
    });

    socket.on('start_discussion', () => {
        gameState = 'DAY_DISCUSSION';
        let living = players.filter(p => p.isAlive);
        currentSpeakerIndex = 0;
        broadcastUpdate();
        broadcastSpeaker();
    });

    socket.on('next_speaker', () => {
        let living = players.filter(p => p.isAlive);
        currentSpeakerIndex++;
        if (currentSpeakerIndex >= living.length) {
            currentSpeakerIndex = living.length - 1;
        }
        broadcastSpeaker();
    });

    socket.on('start_voting', () => {
        gameState = 'DAY_VOTING';
        votes = {};
        lockedVotes = {};
        broadcastUpdate();
        broadcastVotingState();
    });

    socket.on('cast_vote', (targetId) => {
        let voter = players.find(p => p.id === socket.id);
        if (!voter || !voter.isAlive || lockedVotes[socket.id]) return;

        votes[socket.id] = targetId;
        broadcastVotingState();
    });

    socket.on('lock_vote', () => {
        let voter = players.find(p => p.id === socket.id);
        if (!voter || !voter.isAlive || !votes[socket.id]) return;

        lockedVotes[socket.id] = true;
        broadcastVotingState();

        let living = players.filter(p => p.isAlive);
        let allLocked = living.every(p => lockedVotes[p.id]);
        if (allLocked) {
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

function triggerNightMafia() {
    io.emit('trigger_night_mafia', { players: players.filter(p => p.isAlive) });
}

function triggerNightDoctor() {
    io.emit('trigger_night_doctor', { players: players.filter(p => p.isAlive) });
}

function checkWinConditions() {
    let livingMafia = players.filter(p => p.role === 'Mafia' && p.isAlive).length;
    let livingNonMafia = players.filter(p => p.role !== 'Mafia' && p.isAlive).length;

    if (livingMafia === 0) {
        triggerGameOver('Citizens', 'انتصر المواطنون! تم القضاء على جميع أفراد المافيا.');
        return true;
    } else if (livingMafia >= livingNonMafia) {
        triggerGameOver('Mafia', 'انتصرت المافيا! عدد أفراد المافيا أصبح مساوياً أو أكبر من المواطنين.');
        return true;
    }
    return false;
}

function triggerGameOver(winner, message) {
    gameState = 'GAME_OVER';
    let roleBreakdown = players.map(p => ({
        name: p.name,
        role: p.role,
        isAlive: p.isAlive
    }));
    io.emit('game_over', { winner, message, roleBreakdown });
}

function resolveNight() {
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

    if (checkWinConditions()) {
        io.emit('night_summary', { message: resultMessage });
        broadcastUpdate();
        return;
    }

    gameState = 'NIGHT_RESULTS';
    io.emit('night_summary', { message: resultMessage });
    broadcastUpdate();
}

function broadcastSpeaker() {
    let living = players.filter(p => p.isAlive);
    let currentSpeaker = living[currentSpeakerIndex] || null;
    io.emit('speaker_update', { 
        currentSpeaker, 
        speakerIndex: currentSpeakerIndex, 
        totalLiving: living.length 
    });
}

function broadcastVotingState() {
    let living = players.filter(p => p.isAlive);
    let voteBoardData = living.map(p => {
        let votersForMe = players.filter(voter => voter.isAlive && votes[voter.id] === p.id).map(voter => ({
            name: voter.name,
            locked: !!lockedVotes[voter.id]
        }));
        return {
            id: p.id,
            name: p.name,
            voters: votersForMe
        };
    });
    io.emit('voting_state_update', { voteBoardData, votes, lockedVotes });
}

function resolveVoting() {
    let voteCounts = {};
    Object.entries(votes).forEach(([voterId, targetId]) => {
        let voter = players.find(p => p.id === voterId);
        if (voter && voter.isAlive) {
            voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
        }
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

    gameState = 'DAY_RESULTS';
    io.emit('voting_summary', { message });
    broadcastUpdate();

    // Check if this execution ended the game
    if (checkWinConditions()) {
        return; // Stop here so it doesn't loop back into the night phase!
    }

    setTimeout(() => {
        if (gameState === 'GAME_OVER') return;
        gameState = 'NIGHT_MAFIA';
        nightActions = { mafiaKills: [], doctorHeal: null };
        votes = {};
        lockedVotes = {};
        broadcastUpdate();
        triggerNightMafia();
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