
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- Data ---
const rooms = new Map();
const sockets = new Map();

// --- Constants ---
const MISSION_SIZES = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4], // Mission 4 (idx 3) requires 2 fails
    8: [3, 4, 4, 5, 5], // Mission 4 (idx 3) requires 2 fails
    9: [3, 4, 4, 5, 5]  // Mission 4 (idx 3) requires 2 fails
};

const SPY_COUNTS = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3 };

// --- Game Logic ---
function initGame(room) {
    const players = Array.from(room.players.values());
    const count = players.length;
    const spyCount = SPY_COUNTS[count] || 2;
    
    // Roles
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const spies = new Set(shuffled.slice(0, spyCount).map(p => p.id));
    
    let spyIdx = 1;
    players.forEach(p => {
        p.role = spies.has(p.id) ? 'spy' : 'resistance';
        p.spyNumber = spies.has(p.id) ? spyIdx++ : null;
        p.isLeader = false;
        p.confirmedRole = false; // New: track confirmation
        p.voted = false;
        p.missionVote = null;
    });

    const leaderIdx = Math.floor(Math.random() * count);
    players[leaderIdx].isLeader = true;

    room.game = {
        players: players.map(p => ({ ...p })),
        phase: 'roleReveal', // Start with Role Reveal
        currentMission: 1,
        missionSizes: MISSION_SIZES[count] || MISSION_SIZES[5],
        successfulMissions: 0,
        failedMissions: 0,
        currentLeaderIndex: leaderIdx,
        currentPlayerIndex: leaderIdx,
        discussionTurnCount: 0,
        
        discussionTimeLeft: 40,
        nominationTimeLeft: 80,
        tieTimeLeft: 0,
        
        nominatedPlayers: [],
        votes: {},
        missionTeam: [],
        missionVotes: {},
        missionResults: [],
        tieCandidates: [],
        isTieBreakerVote: false,
        
        gameOver: false,
        winner: null
    };
}

function checkAllRolesConfirmed(game) {
    if (game.players.every(p => p.confirmedRole)) {
        game.phase = 'discussion';
        game.discussionTimeLeft = 40;
        return true;
    }
    return false;
}

function nextMission(game) {
    game.currentMission++;
    game.players.forEach(p => {
        p.nominated = false;
        p.voted = false;
        p.missionVote = null;
        p.isLeader = false;
    });
    game.nominatedPlayers = [];
    game.votes = {};
    game.missionTeam = [];
    game.missionVotes = {};
    game.tieCandidates = [];
    game.isTieBreakerVote = false;

    const nextIdx = (game.currentLeaderIndex + 1) % game.players.length;
    game.currentLeaderIndex = nextIdx;
    game.players[nextIdx].isLeader = true;
    
    game.phase = 'discussion';
    game.currentPlayerIndex = nextIdx;
    game.discussionTimeLeft = 40;
    game.discussionTurnCount = 0;
}

function finalizeDiscussion(game) {
    const candidates = game.nominatedPlayers;
    game.players.forEach(p => p.isLeader = false);

    if (candidates.length === 0) {
        // Fallback to starter
        const starter = game.players[game.currentLeaderIndex];
        starter.isLeader = true;
        game.phase = 'leaderDiscussion';
        game.discussionTimeLeft = 40;
        game.currentPlayerIndex = game.currentLeaderIndex;
        game.discussionTurnCount = 0;
    } else if (candidates.length === 1) {
        // Auto-win
        const winner = game.players.find(p => p.name === candidates[0]);
        if (winner) winner.isLeader = true;
        game.currentLeaderIndex = game.players.indexOf(winner);
        
        game.phase = 'leaderDiscussion';
        game.discussionTimeLeft = 40;
        game.currentPlayerIndex = game.currentLeaderIndex;
        game.discussionTurnCount = 0;
    } else {
        game.phase = 'voting';
        game.votes = {};
        game.players.forEach(p => p.voted = false);
    }
}

// --- Loop ---
setInterval(() => {
    rooms.forEach(room => {
        if (!room.game || room.game.gameOver) return;
        const g = room.game;
        let changed = false;

        if (g.phase === 'discussion' || g.phase === 'leaderDiscussion') {
            if (g.discussionTimeLeft > 0) {
                g.discussionTimeLeft--;
                changed = true;
            } else {
                // Turn over
                g.discussionTurnCount++;
                if (g.discussionTurnCount >= g.players.length) {
                    if (g.phase === 'leaderDiscussion') {
                        g.phase = 'missionTeamSelection';
                        g.nominationTimeLeft = 80;
                    } else {
                        finalizeDiscussion(g);
                    }
                } else {
                    g.currentPlayerIndex = (g.currentPlayerIndex + 1) % g.players.length;
                    g.discussionTimeLeft = 40;
                }
                changed = true;
            }
        } else if (g.phase === 'missionTeamSelection') {
             if (g.nominationTimeLeft > 0) {
                 g.nominationTimeLeft--;
                 changed = true;
             } else {
                 // Timeout -> Fail
                 g.missionResults.push({ mission: g.currentMission, success: false, failCount: 0, successCount: 0 });
                 g.failedMissions++;
                 if (g.failedMissions >= 3) { g.gameOver = true; g.winner = 'spy'; g.phase = 'missionResults'; }
                 else nextMission(g);
                 changed = true;
             }
        } else if (g.phase === 'tieDiscussion') {
            if (g.tieTimeLeft > 0) {
                g.tieTimeLeft--;
                changed = true;
            } else {
                g.phase = 'voting';
                g.players.forEach(p => p.voted = false);
                g.votes = {};
                changed = true;
            }
        }

        if (changed) broadcastGameState(room);
        
        // Ping KeepAlive
        wss.clients.forEach(ws => { if(ws.isAlive) ws.ping(); });
    });
}, 1000);

// --- Networking ---
function broadcastLobby() {
    const list = Array.from(rooms.values()).map(r => ({
        id: r.id, name: r.name, host: r.hostName, players: r.players.size, maxPlayers: r.maxPlayers, hasPassword: !!r.password
    }));
    const msg = JSON.stringify({ type: 'lobby', rooms: list });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function broadcastRoom(room) {
    const msg = JSON.stringify({
        type: 'room',
        room: {
            id: room.id, name: room.name, hostId: room.hostId, maxPlayers: room.maxPlayers, inviteKey: room.inviteKey,
            players: Array.from(room.players.values())
        }
    });
    room.players.forEach((_, id) => {
        const ws = Array.from(sockets.entries()).find(([, u]) => u.id === id)?.[0];
        if (ws && ws.readyState === 1) ws.send(msg);
    });
}

function broadcastGameState(room) {
    if (!room.game) return;
    const spies = room.game.players.filter(p => p.role === 'spy').map(p => ({ id: p.id, name: p.name, spyNumber: p.spyNumber }));
    
    room.game.players.forEach(p => {
        const ws = Array.from(sockets.entries()).find(([, u]) => u.id === p.id)?.[0];
        if (ws && ws.readyState === 1) {
            const safeGame = { ...room.game };
            safeGame.players = safeGame.players.map(pl => {
                if (pl.id === p.id) return pl;
                return { ...pl, role: 'unknown', spyNumber: null, missionVote: null };
            });
            const msg = { type: 'game', game: safeGame, you: p };
            if (p.role === 'spy') msg.spies = spies;
            ws.send(JSON.stringify(msg));
        }
    });
}

wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => ws.isAlive = true);
    
    const user = { id: null, name: null, roomId: null };
    sockets.set(ws, user);

    ws.on('message', raw => {
        try {
            const data = JSON.parse(raw);
            
            if (data.type === 'hello') {
                user.id = data.userId || nanoid();
                user.name = data.name || 'Player';
                broadcastLobby();
            } else if (data.type === 'createRoom') {
                const roomId = nanoid(6);
                const room = {
                    id: roomId, name: data.name, password: data.password, maxPlayers: data.maxPlayers,
                    hostId: user.id, hostName: user.name, inviteKey: nanoid(8), players: new Map(), game: null
                };
                room.players.set(user.id, { id: user.id, name: user.name });
                rooms.set(roomId, room);
                user.roomId = roomId;
                broadcastLobby();
                broadcastRoom(room);
            } else if (data.type === 'joinRoom') {
                const room = rooms.get(data.roomId);
                if (room) {
                    if (room.players.size < room.maxPlayers) {
                         if (room.inviteKey === data.inviteKey || !room.password || room.password === data.password) {
                             room.players.set(user.id, { id: user.id, name: user.name });
                             user.roomId = room.id;
                             broadcastLobby();
                             broadcastRoom(room);
                             if (room.game) broadcastGameState(room);
                         } else ws.send(JSON.stringify({type:'error', message:'Неверный пароль'}));
                    } else ws.send(JSON.stringify({type:'error', message:'Комната полна'}));
                }
            } else if (data.type === 'leaveRoom') {
                const room = rooms.get(user.roomId);
                if (room) {
                    room.players.delete(user.id);
                    if (room.players.size === 0) rooms.delete(room.id);
                    else {
                        if (room.hostId === user.id) {
                            const next = room.players.values().next().value;
                            room.hostId = next.id;
                            room.hostName = next.name;
                        }
                        broadcastRoom(room);
                    }
                    user.roomId = null;
                    broadcastLobby();
                }
            } else if (data.type === 'startGame') {
                const room = rooms.get(user.roomId);
                if (room && room.hostId === user.id && room.players.size >= 5) {
                    initGame(room);
                    broadcastGameState(room);
                }
            } else if (data.type === 'action') {
                const room = rooms.get(user.roomId);
                if (room && room.game) {
                    const act = data.action;
                    const game = room.game;
                    const me = game.players.find(p => p.id === user.id);
                    
                    if (act.name === 'confirmRole' && game.phase === 'roleReveal') {
                        me.confirmedRole = true;
                        if (checkAllRolesConfirmed(game)) broadcastGameState(room);
                        else broadcastGameState(room); // Update status
                    }
                    else if (act.name === 'passTurn' || act.name === 'passTurnLeaderDiscussion') {
                        if (game.players[game.currentPlayerIndex].id === user.id || room.hostId === user.id) {
                            game.discussionTimeLeft = 0; // Force timer end
                        }
                    } else if (act.name === 'nominate') {
                        if (game.phase === 'discussion' || game.phase === 'nomination') {
                            if (game.nominatedPlayers.includes(act.target)) {
                                game.nominatedPlayers = game.nominatedPlayers.filter(n => n !== act.target);
                            } else {
                                game.nominatedPlayers.push(act.target);
                            }
                            broadcastGameState(room);
                        }
                    } else if (act.name === 'voteForLeader' && game.phase === 'voting' && !me.voted) {
                        if (game.tieCandidates.length > 0 && !game.tieCandidates.includes(act.candidate)) return;
                        me.voted = true;
                        game.votes[me.id] = act.candidate;
                        if (game.players.every(p => p.voted)) {
                            // Process Votes
                            const counts = {};
                            Object.values(game.votes).forEach(v => counts[v] = (counts[v]||0)+1);
                            let max = 0;
                            Object.values(counts).forEach(c => max = Math.max(max, c));
                            const winners = Object.keys(counts).filter(c => counts[c] === max);
                            
                            if (winners.length === 1) {
                                const w = game.players.find(p => p.name === winners[0]);
                                game.players.forEach(p => p.isLeader = false);
                                w.isLeader = true;
                                game.currentLeaderIndex = game.players.indexOf(w);
                                game.phase = 'leaderDiscussion';
                                game.currentPlayerIndex = game.currentLeaderIndex;
                                game.discussionTimeLeft = 40;
                                game.discussionTurnCount = 0;
                                game.tieCandidates = [];
                                game.isTieBreakerVote = false;
                            } else {
                                if (game.isTieBreakerVote) {
                                    // Auto resolve (first winner or starter choice)
                                    const starter = game.players[game.currentLeaderIndex];
                                    const sv = game.votes[starter.id];
                                    const final = winners.includes(sv) ? sv : winners[0];
                                    const w = game.players.find(p => p.name === final);
                                    game.players.forEach(p => p.isLeader = false);
                                    w.isLeader = true;
                                    game.currentLeaderIndex = game.players.indexOf(w);
                                    game.phase = 'leaderDiscussion';
                                    game.currentPlayerIndex = game.currentLeaderIndex;
                                    game.discussionTimeLeft = 40;
                                    game.discussionTurnCount = 0;
                                    game.tieCandidates = [];
                                    game.isTieBreakerVote = false;
                                } else {
                                    game.tieCandidates = winners;
                                    game.phase = 'tieDiscussion';
                                    game.tieTimeLeft = 30 * winners.length;
                                    game.isTieBreakerVote = true;
                                }
                            }
                        }
                        broadcastGameState(room);
                    } else if (act.name === 'toggleTeamMember' && game.phase === 'missionTeamSelection' && me.isLeader) {
                        if (game.missionTeam.includes(act.target)) game.missionTeam = game.missionTeam.filter(t => t !== act.target);
                        else if (game.missionTeam.length < game.missionSizes[game.currentMission-1]) game.missionTeam.push(act.target);
                        broadcastGameState(room);
                    } else if (act.name === 'approveTeam' && game.phase === 'missionTeamSelection' && me.isLeader) {
                        if (game.missionTeam.length === game.missionSizes[game.currentMission-1]) {
                            game.phase = 'missionVoting';
                            broadcastGameState(room);
                        }
                    } else if (act.name === 'voteForMission' && game.phase === 'missionVoting' && game.missionTeam.includes(me.name) && !me.missionVote) {
                        if (me.role === 'resistance' && act.vote === 'fail') return;
                        me.missionVote = act.vote;
                        game.missionVotes[me.id] = act.vote;
                        
                        if (Object.keys(game.missionVotes).length === game.missionTeam.length) {
                            let fails = 0;
                            Object.values(game.missionVotes).forEach(v => { if (v === 'fail') fails++; });
                            const success = (game.currentMission === 4 && game.players.length >= 7) ? fails < 2 : fails === 0;
                            
                            game.missionResults.push({ mission: game.currentMission, success, failCount: fails, successCount: game.missionTeam.length - fails });
                            if (success) game.successfulMissions++; else game.failedMissions++;
                            
                            if (game.successfulMissions >= 3) { game.gameOver = true; game.winner = 'resistance'; }
                            else if (game.failedMissions >= 3) { game.gameOver = true; game.winner = 'spy'; }
                            
                            game.phase = 'missionResults';
                        }
                        broadcastGameState(room);
                    } else if (act.name === 'nextMission' && game.phase === 'missionResults') {
                        nextMission(game);
                        broadcastGameState(room);
                    }
                }
            }
        } catch(e) { console.error(e); }
    });
    
    ws.on('close', () => {
        const u = sockets.get(ws);
        if (u && u.roomId) {
            const r = rooms.get(u.roomId);
            if (r) {
                r.players.delete(u.id);
                if (r.players.size === 0) rooms.delete(r.id);
                else {
                     if (r.hostId === u.id) {
                         const next = r.players.values().next().value;
                         if (next) { r.hostId = next.id; r.hostName = next.name; }
                     }
                     broadcastRoom(r);
                }
            }
            broadcastLobby();
        }
        sockets.delete(ws);
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log('Server running on ' + PORT));
