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

let players = []; // { id, name, role, isAlive, socket }
let hostId = null;
let gameState = 'LOBBY'; // LOBBY, NIGHT_MAFIA, NIGHT_DOCTOR, NIGHT_RESULTS, DAY_VOTING, DEFENSE

let nightActions = {
    mafiaKills: [],
    doctorHeal: null,
    detectiveCheck: null
};

let votes = {}; // targetSocketId -> count
let currentTrialPlayer = null;

io.on('connection', (socket) => {
    console.log(`Connection established: ${socket.id}`);

    // First connected user becomes host automatically if none exists
    if (!hostId) {
        hostId = socket.id;
        socket.emit('set_host');
    }

    socket.on('join_game', (nickname) => {
        let cleanName = nickname.trim() || `Player ${players.length + 1}`;
        players.push({
            id: socket.id,
            name: cleanName,
            role: 'Citizen',
            isAlive: true
        });
        broadcastLobbyState();
    });

    // Host configures game and starts
    socket.on('start_game_config', (config) => {
        if (socket.id !== hostId || players.length < 4) return;
        
        assignRoles(config);
        gameState = 'NIGHT_MAFIA';
        nightActions = { mafiaKills: [], doctorHeal: null, detectiveCheck: null };
        
        io.emit('game_started', { state: gameState });
        sendNightPrompts();
    });

    // Mafia action submission
    socket.on('mafia_action', (data) => {
        let player = players.find(p => p.id === socket.id);
        if (!player || player.role !== 'Mafia' || !player.isAlive) return;

        nightActions.mafiaKills.push({ mafiaName: player.name, targetId: data.targetId, action: data.action });
        
        // Broadcast action to fellow mafia so they coordinate live
        let mafiaSockets = players.filter(p => p.role === 'Mafia' && p.isAlive);
        mafiaSockets.forEach(m => {
            io.to(m.id).emit('mafia_live_log', nightActions.mafiaKills);
        });

        // If all active mafia have acted, move to Doctor phase
        if (nightActions.mafiaKills.length >= mafiaSockets.length) {
            gameState = 'NIGHT_DOCTOR';
            sendNightPrompts();
        }
    });

    // Doctor action submission
    socket.on('doctor_action', (targetId) => {
        let player = players.find(p => p.id === socket.id);
        if (!player || player.role !== 'Doctor' || !player.isAlive) {
            // If no doctor is alive/active, skip straight to results
            resolveNight();
            return;
        }

        nightActions.doctorHeal = targetId;
        resolveNight();
    });

    // Voting submission
    socket.on('cast_vote', (targetId) => {
        let voter = players.find(p => p.id === socket.id);
        if (!voter || !voter.isAlive) return;

        votes[socket.id] = targetId;
        
        // Check if all living players voted
        let livingPlayers = players.filter(p => p.isAlive);
        if (Object.keys(votes).length >= livingPlayers.length) {
             tallyVotes();
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        if (socket.id === hostId && players.length > 0) {
            hostId = players[0].id;
            io.to(hostId).emit('set_host');
        }
        broadcastLobbyState();
    });
});

function broadcastLobbyState() {
    io.emit('update_lobby', {
        players: players.map(p => ({ id: p.id, name: p.name })),
        state: gameState
    });
}

function assignRoles(config) {
    let shuffled = [...players].sort(() => 0.5 - Math.random());
    let mafiaCount = parseInt(config.mafiaCount) || 1;
    let includeDoctor = config.includeDoctor;
    let includeDetective = config.includeDetective;

    shuffled.forEach((p, index) => {
        let playerRef = players.find(x => x.id === p.id);
        if (index < mafiaCount) {
            playerRef.role = 'Mafia';
        } else if (includeDoctor && index === mafiaCount) {
            playerRef.role = 'Doctor';
        } else if (includeDetective && index === mafiaCount + 1) {
            playerRef.role = 'Detective';
        } else {
            playerRef.role = 'Citizen';
        }
    });

    players.forEach(p => {
        io.to(p.id).emit('your_role', { role: p.role });
    });
}

function sendNightPrompts() {
    io.emit('phase_change', { state: gameState, livingPlayers: players.filter(p => p.isAlive) });
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
        if (victim) {
            victim.isAlive = false;
        }
        resultMessage = `عملية قتل ناجحة !! تم تصفية ${victim ? victim.name : 'الضحية'}`;
    } else {
        resultMessage = `لم يحدث شيء في هذه الليلة, الهدوء يعم المكان.`;
    }

    io.emit('night_summary', { message: resultMessage, livingPlayers: players.filter(p => p.isAlive) });
}

function tallyVotes() {
    let tally = {};
    Object.values(votes).forEach(targetId => {
        tally[targetId] = (tally[targetId] || 0) + 1;
    });

    let maxVotes = 0;
    let suspectId = null;
    for (let targetId in tally) {
        if (tally[targetId] > maxVotes) {
            maxVotes = tally[targetId];
            suspectId = targetId;
        }
    }

    currentTrialPlayer = players.find(p => p.id === suspectId);
    gameState = 'DEFENSE';
    
    io.emit('player_on_trial', {
        suspect: currentTrialPlayer ? currentTrialPlayer.name : 'None',
        votesCount: maxVotes
    });
}

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return 'localhost';
}

const PORT = 3000;
server.listen(PORT, () => {
    const localUrl = `http://${getLocalIP()}:${PORT}`;
    console.log(`\n========================================`);
    console.log(` Hallway Mafia Server Active!`);
    console.log(` URL for phones: ${localUrl}`);
    console.log(`========================================\n`);
    qrcode.generate(localUrl, { small: true });
});