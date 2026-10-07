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

let players = []; // { id, name, role, isAlive, isConnected, mayorRevealed, detectiveHasBullet }
let gameState = 'LOBBY'; 
let nightActions = {
    mafiaKills: [],
    doctorHeal: null,
    detectiveShot: null
};
let votes = {}; // socketId -> targetId
let lockedVotes = {}; // socketId -> boolean
let currentSpeakerIndex = 0;

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.emit('state_update', { gameState, players: getSafePlayers() });

    socket.on('join_game', (nickname) => {
        let cleanName = nickname.trim();
        if (!cleanName) return;

        let existingPlayer = players.find(p => p.name.toLowerCase() === cleanName.toLowerCase());

        if (gameState === 'LOBBY') {
            players = players.filter(p => p.id !== socket.id && p.name.toLowerCase() !== cleanName.toLowerCase());
            players.push({
                id: socket.id,
                name: cleanName,
                role: null,
                isAlive: true,
                isConnected: true,
                mayorRevealed: false,
                detectiveHasBullet: true
            });
            socket.emit('join_success');
            broadcastUpdate();
        } else {
            if (existingPlayer) {
                existingPlayer.id = socket.id;
                existingPlayer.isConnected = true;

                socket.emit('join_success');
                socket.emit('your_role', { 
                    role: existingPlayer.role, 
                    mayorRevealed: existingPlayer.mayorRevealed,
                    detectiveHasBullet: existingPlayer.detectiveHasBullet
                });
                
                if (!existingPlayer.isAlive) {
                    socket.emit('player_died');
                }

                broadcastUpdate();
                console.log(`تم إعادة اتصال اللاعب: ${existingPlayer.name} (${socket.id})`);
            } else {
                socket.emit('error_message', 'العبة قد بدأت بالفعل!');
            }
        }
    });

    socket.on('start_game_config', (config) => {
        if (players.length < 4) return; // Need at least 4 for these roles
        
        assignRoles(config);
        gameState = 'NIGHT_MAFIA';
        nightActions = { mafiaKills: [], doctorHeal: null, detectiveShot: null };
        
        broadcastUpdate();
        triggerNightMafia();
    });

    socket.on('reset_to_lobby', () => {
        gameState = 'LOBBY';
        players.forEach(p => {
            p.role = null;
            p.isAlive = true;
            p.isConnected = true;
            p.mayorRevealed = false;
            p.detectiveHasBullet = true;
        });
        nightActions = { mafiaKills: [], doctorHeal: null, detectiveShot: null };
        votes = {};
        lockedVotes = {};
        currentSpeakerIndex = 0;
        broadcastUpdate();
        io.emit('reset_client');
    });

    // Mayor action: Reveal identity
    socket.on('mayor_reveal', () => {
        let player = players.find(p => p.id === socket.id);
        if (!player || player.role !== 'Mayor' || !player.isAlive || player.mayorRevealed) return;
        
        player.mayorRevealed = true;
        io.emit('announcement', `📢 كشف العمدة (${player.name}) عن نفسه! صوته الآن يساوى 3 أصوات.`);
        broadcastUpdate();
        broadcastVotingState();
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
            proceedAfterMafia();
        }
    });

    socket.on('doctor_action', (targetId) => {
        let player = players.find(p => p.id === socket.id);
        if (!player || player.role !== 'Doctor' || !player.isAlive) return;
        nightActions.doctorHeal = targetId;
        proceedAfterDoctor();
    });

    socket.on('detective_action', (targetId) => {
        let player = players.find(p => p.id === socket.id);
        if (!player || player.role !== 'Detective' || !player.isAlive || !player.detectiveHasBullet) return;
        
        if (targetId) {
            player.detectiveHasBullet = false;
            nightActions.detectiveShot = targetId;
        } else {
            nightActions.detectiveShot = null; // Skipped shot
        }
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
        let player = players.find(p => p.id === socket.id);
        if (player) {
            if (gameState === 'LOBBY') {
                players = players.filter(p => p.id !== socket.id);
            } else {
                player.isConnected = false;
            }
        }
        broadcastUpdate();
    });
});

function getSafePlayers() {
    return players.map(p => ({
        id: p.id,
        name: p.name,
        isAlive: p.isAlive,
        isConnected: p.isConnected,
        mayorRevealed: p.mayorRevealed
    }));
}

function broadcastUpdate() {
    io.emit('state_update', { gameState, players: getSafePlayers() });
}

function assignRoles(config) {
    let shuffled = [...players].sort(() => 0.5 - Math.random());
    let mafiaCount = parseInt(config.mafiaCount) || 1;
    let includeDoctor = config.includeDoctor;
    let includeMayor = config.includeMayor;
    let includeDetective = config.includeDetective;

    let assignedCount = 0;

    shuffled.forEach((p, index) => {
        let playerRef = players.find(x => x.id === p.id);
        if (index < mafiaCount) {
            playerRef.role = 'Mafia';
        } else if (includeDoctor && assignedCount === 0) {
            playerRef.role = 'Doctor';
            assignedCount++;
        } else if (includeMayor && assignedCount === 1) {
            playerRef.role = 'Mayor';
            assignedCount++;
        } else if (includeDetective && assignedCount === 2) {
            playerRef.role = 'Detective';
            assignedCount++;
        } else {
            playerRef.role = 'Citizen';
        }
    });

    players.forEach(p => {
        io.to(p.id).emit('your_role', { 
            role: p.role, 
            mayorRevealed: p.mayorRevealed, 
            detectiveHasBullet: p.detectiveHasBullet 
        });
    });
}

function triggerNightMafia() {
    io.emit('trigger_night_mafia', { players: players.filter(p => p.isAlive) });
}

function triggerNightDoctor() {
    io.emit('trigger_night_doctor', { players: players.filter(p => p.isAlive) });
}

function triggerNightDetective() {
    io.emit('trigger_night_detective', { players: players.filter(p => p.isAlive) });
}

function proceedAfterMafia() {
    let doctorAlive = players.some(p => p.role === 'Doctor' && p.isAlive);
    if (doctorAlive) {
        gameState = 'NIGHT_DOCTOR';
        broadcastUpdate();
        triggerNightDoctor();
    } else {
        proceedAfterDoctor();
    }
}

function proceedAfterDoctor() {
    let detectiveAlive = players.some(p => p.role === 'Detective' && p.isAlive && p.detectiveHasBullet);
    if (detectiveAlive) {
        gameState = 'NIGHT_DETECTIVE';
        broadcastUpdate();
        triggerNightDetective();
    } else {
        resolveNight();
    }
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
    let shotTargetId = nightActions.detectiveShot;

    let resultMessages = [];
    let victim = players.find(p => p.id === killedTargetId);
    let shotVictim = players.find(p => p.id === shotTargetId);

    // Resolve Mafia Kill & Doctor Heal
    if (killedTargetId && killedTargetId === healedTargetId) {
        resultMessages.push(`عملية قتل فاشلة من المافيا، تمت معالجة الشخص المستهدف.`);
    } else if (killedTargetId) {
        if (victim && victim.isAlive) {
            victim.isAlive = false;
            resultMessages.push(`عملية قتل ناجحة !! تم تصفية ${victim.name} من قبل المافيا.`);
        }
    } else {
        resultMessages.push(`لم يحدث هجوم ليلي من المافيا.`);
    }

    // Resolve Detective Shot
    if (shotTargetId && shotVictim && shotVictim.isAlive) {
        shotVictim.isAlive = false;
        resultMessages.push(`أطلق المحقق النار في الليل وقام بتصفية ${shotVictim.name}!`);
    }

    let finalMessage = resultMessages.join(' | ');

    // Reset night actions for next cycle
    nightActions = { mafiaKills: [], doctorHeal: null, detectiveShot: null };

    if (checkWinConditions()) {
        io.emit('night_summary', { message: finalMessage });
        broadcastUpdate();
        return;
    }

    gameState = 'NIGHT_RESULTS';
    io.emit('night_summary', { message: finalMessage });
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
        let votersForMe = [];
        players.forEach(voter => {
            if (voter.isAlive && votes[voter.id] === p.id) {
                let weight = (voter.role === 'Mayor' && voter.mayorRevealed) ? 3 : 1;
                for (let i = 0; i < weight; i++) {
                    votersForMe.push({
                        name: voter.name + (weight > 3 ? '' : ''),
                        locked: !!lockedVotes[voter.id]
                    });
                }
            }
        });
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
            let weight = (voter.role === 'Mayor' && voter.mayorRevealed) ? 3 : 1;
            voteCounts[targetId] = (voteCounts[targetId] || 0) + weight;
        }
    });

    let highestVotes = 0;
    let executedId = null;
    let isTie = false;

    for (let [targetId, count] of Object.entries(voteCounts)) {
        if (count > highestVotes) {
            highestVotes = count;
            executedId = targetId;
            isTie = false;
        } else if (count === highestVotes) {
            isTie = true;
        }
    }

    let victim = (!isTie && executedId) ? players.find(p => p.id === executedId) : null;
    let message = '';
    if (victim) {
        victim.isAlive = false;
        message = `نتيجة التصويت: تم إعدام ${victim.name} بواسطة التصويت الجماعي بأصوات بلغت ${highestVotes}!`;
    } else {
        message = `لم يتم إعدام أي شخص (تعادل في أصوات التصويت).`;
    }

    gameState = 'DAY_RESULTS';
    io.emit('voting_summary', { message });
    broadcastUpdate();

    if (checkWinConditions()) {
        return;
    }

    setTimeout(() => {
        if (gameState === 'GAME_OVER') return;
        gameState = 'NIGHT_MAFIA';
        nightActions = { mafiaKills: [], doctorHeal: null, detectiveShot: null };
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
    console.log(` لوحة تحكم المضيف: ${localUrl}`);
    console.log(` رابط انضمام اللاعبين: ${localUrl}/player.html`);
    console.log(`========================================\n`);
    qrcode.generate(`${localUrl}/player.html`, { small: true });
});