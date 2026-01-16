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

// --- Data Stores ---
const rooms = new Map(); // roomId -> Room
const sockets = new Map(); // ws -> { id, name, roomId }

// --- Constants ---
const MISSION_SIZES = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4], // Correction based on prompt logic usually, but let's strictly follow prompt
    // Prompt: 7 players: 2, 3, 4, 3, 4 ?? Prompt said: "1-2, 2-3, 3-4, 4-3, 5-4"
    // Wait, prompt text: "При игре в 7 ... 1 миссия - 2, 2 миссия - 3, 3 миссия - 4, 4 миссия - 3, 5 миссия - 4"
    8: [3, 4, 5, 4, 5],
    9: [3, 4, 4, 5, 5]
};
// Correction for 7 players per prompt text: [2,3,4,3,4]

const SPY_COUNTS = { 5: 2, 6: 2, 7: 3, 8: 3, 9: 3 };

// --- Helpers ---
function getMissionSizes(count) {
    if (count === 7) return [2, 3, 4, 3, 4]; // Explicit prompt requirement
    return MISSION_SIZES[count] || MISSION_SIZES[5];
}

function heartbeat() {
    this.isAlive = true;
}

// --- Game Logic ---
function initGame(room) {
    const players = Array.from(room.players.values());
    const count = players.length;
    const spyCount = SPY_COUNTS[count] || 2;
    
    // Assign Roles
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const spies = new Set(shuffled.slice(0, spyCount).map(p => p.id));
    
    let spyIdx = 1;
    players.forEach(p => {
        if (spies.has(p.id)) {
            p.role = 'spy';
            p.spyNumber = spyIdx++;
        } else {
            p.role = 'resistance';
            p.spyNumber = null;
        }
        p.isLeader = false;
        p.nominated = false;
        p.voted = false;
        p.missionVote = null;
        p.confirmedRole = false;
    });

    const leaderIdx = Math.floor(Math.random() * count);
    players[leaderIdx].isLeader = true;

    room.game = {
        players: players.map(p => ({ ...p })), // Clone
        phase: 'roleReveal', // Start with Role Reveal
        currentMission: 1,
        missionSizes: getMissionSizes(count),
        successfulMissions: 0,
        failedMissions: 0,
        currentLeaderIndex: leaderIdx,
        currentPlayerIndex: leaderIdx, // For discussion turn
        discussionTurnCount: 0,
        
        // Timers
        discussionTimeLeft: 40,
        nominationTimeLeft: 80,
        tieTimeLeft: 0,
        
        // State
        nominatedPlayers: [],
        votes: {}, // leader votes
        missionTeam: [],
        missionVotes: {}, // success/fail
        missionResults: [],
        tieCandidates: [],
        isTieBreakerVote: false,
        
        gameOver: false,
        winner: null
    };
}

function checkAllRolesConfirmed(game) {
    const allConfirmed = game.players.every(p => p.confirmedRole);
    if (allConfirmed) {
        game.phase = 'discussion';
        game.discussionTimeLeft = 40;
        game.discussionTurnCount = 0;
        // Start discussion with current leader
        game.currentPlayerIndex = game.currentLeaderIndex;
        return true;
    }
    return false;
}

function finalizeDiscussion(game) {
    const candidates = game.nominatedPlayers;
    
    // Clear leader status for visual clarity before voting/new leader
    game.players.forEach(p => p.isLeader = false);

    if (candidates.length === 0) {
        // No candidates: Starter becomes leader
        const starter = game.players[game.currentLeaderIndex];
        starter.isLeader = true;
        // No index change for leader, but discussion resets
        game.phase = 'leaderDiscussion';
        game.discussionTimeLeft = 40;
        game.currentPlayerIndex = game.currentLeaderIndex;
        game.discussionTurnCount = 0;
    } else if (candidates.length === 1) {
        // 1 Candidate: Auto-wins
        const winner = game.players.find(p => p.name === candidates[0]);
        if (winner) winner.isLeader = true;
        game.currentLeaderIndex = game.players.indexOf(winner);
        
        game.phase = 'leaderDiscussion';
        game.discussionTimeLeft = 40;
        game.currentPlayerIndex = game.currentLeaderIndex;
        game.discussionTurnCount = 0;
    } else {
        // Voting
        game.phase = 'voting';
        game.votes = {};
        game.players.forEach(p => p.voted = false);
    }
}

function processLeaderVote(game) {
    // Tally votes
    const counts = {};
    Object.values(game.votes).forEach(name => counts[name] = (counts[name] || 0) + 1);
    
    // Find max
    let max = 0;
    Object.values(counts).forEach(c => { if (c > max) max = c; });
    
    const winners = Object.keys(counts).filter(n => counts[n] === max);
    
    // If NO votes cast (empty), fallback to starter
    if (winners.length === 0 && game.tieCandidates.length === 0) {
        const starter = game.players[game.currentLeaderIndex];
        starter.isLeader = true;
        game.phase = 'leaderDiscussion';
        game.discussionTimeLeft = 40;
        return;
    }

    if (winners.length === 1) {
        // Clear winner
        const wName = winners[0];
        game.players.forEach(p => p.isLeader = false);
        const leader = game.players.find(p => p.name === wName);
        leader.isLeader = true;
        game.currentLeaderIndex = game.players.indexOf(leader);
        
        game.phase = 'leaderDiscussion';
        game.discussionTimeLeft = 40;
        game.currentPlayerIndex = game.currentLeaderIndex;
        game.discussionTurnCount = 0;
        
        game.tieCandidates = [];
        game.isTieBreakerVote = false;
    } else {
        // Tie
        if (game.isTieBreakerVote) {
            // Second tie -> Auto select based on starter preference or starter
            // Simplified: If starter voted for one of them, that one wins. Else first.
            const starter = game.players[game.currentLeaderIndex];
            const starterVote = game.votes[starter.id];
            
            let finalWinner = winners[0];
            if (winners.includes(starterVote)) finalWinner = starterVote;
            
            game.players.forEach(p => p.isLeader = false);
            const leader = game.players.find(p => p.name === finalWinner);
            leader.isLeader = true;
            game.currentLeaderIndex = game.players.indexOf(leader);
            
            game.phase = 'leaderDiscussion';
            game.discussionTimeLeft = 40;
            game.currentPlayerIndex = game.currentLeaderIndex;
            game.discussionTurnCount = 0;
            
            game.tieCandidates = [];
            game.isTieBreakerVote = false;
        } else {
            // First tie -> Tie Discussion
            // Filter candidates to only winners
            game.tieCandidates = winners;
            game.phase = 'tieDiscussion';
            game.tieTimeLeft = 30 * winners.length; // 30s per candidate total pool
            game.isTieBreakerVote = true;
        }
    }
}

function nextMission(game) {
    game.currentMission++;
    
    // Reset state
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

    // Next leader in circle
    const nextIdx = (game.currentLeaderIndex + 1) % game.players.length;
    game.currentLeaderIndex = nextIdx;
    game.players[nextIdx].isLeader = true;
    
    game.phase = 'discussion';
    game.currentPlayerIndex = nextIdx;
    game.discussionTimeLeft = 40;
    game.discussionTurnCount = 0;
}

// --- Server Loop ---
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });

    rooms.forEach(room => {
        if (!room.game || room.game.gameOver) return;
        const game = room.game;
        let changed = false;

        if (game.phase === 'discussion' || game.phase === 'leaderDiscussion') {
            if (game.discussionTimeLeft > 0) {
                game.discussionTimeLeft--;
                changed = true;
            } else {
                // Turn passed
                game.discussionTurnCount++;
                if (game.discussionTurnCount >= game.players.length) {
                    if (game.phase === 'leaderDiscussion') {
                        game.phase = 'missionTeamSelection';
                        game.nominationTimeLeft = 80;
                    } else {
                        finalizeDiscussion(game);
                    }
                } else {
                    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
                    game.discussionTimeLeft = 40;
                }
                changed = true;
            }
        } else if (game.phase === 'missionTeamSelection') {
            if (game.nominationTimeLeft > 0) {
                game.nominationTimeLeft--;
                changed = true;
            } else {
                // Timeout -> Fail Mission
                game.missionResults.push({
                    mission: game.currentMission,
                    success: false,
                    failCount: 0,
                    note: 'Таймаут'
                });
                game.failedMissions++;
                if (game.failedMissions >= 3) {
                    game.gameOver = true;
                    game.winner = 'spy';
                    game.phase = 'missionResults';
                } else {
                    nextMission(game);
                }
                changed = true;
            }
        } else if (game.phase === 'tieDiscussion') {
            if (game.tieTimeLeft > 0) {
                game.tieTimeLeft--;
                changed = true;
            } else {
                game.phase = 'voting';
                game.players.forEach(p => p.voted = false);
                game.votes = {};
                changed = true;
            }
        }

        if (changed) broadcastGameState(room);
    });
}, 1000);

wss.on('close', () => clearInterval(interval));

// --- Broadcast ---
function broadcastLobby() {
    const list = Array.from(rooms.values()).map(r => ({
        id: r.id,
        name: r.name,
        host: r.hostName,
        players: r.players.size,
        maxPlayers: r.maxPlayers,
        hasPassword: !!r.password
    }));
    const msg = JSON.stringify({ type: 'lobby', rooms: list });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function broadcastRoom(room) {
    const msg = JSON.stringify({
        type: 'room',
        room: {
            id: room.id,
            name: room.name,
            hostId: room.hostId,
            maxPlayers: room.maxPlayers,
            inviteKey: room.inviteKey,
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
            // Masking
            const safeGame = { ...room.game };
            safeGame.players = safeGame.players.map(pl => {
                if (pl.id === p.id) return pl; // Reveal self
                return { ...pl, role: 'unknown', spyNumber: null, missionVote: null }; // Mask others
            });
            // Reveal votes if phase is result? No, votes are anonymous usually. 
            // Only leader votes are public. Mission votes are anonymous count.
            
            const msg = { type: 'game', game: safeGame, you: p };
            if (p.role === 'spy') msg.spies = spies;
            ws.send(JSON.stringify(msg));
        }
    });
}

// --- Connection ---
wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);
    
    const user = { id: null, name: null, roomId: null };
    sockets.set(ws, user);

    ws.on('message', raw => {
        try {
            const data = JSON.parse(raw);
            
            if (data.type === 'hello') {
                user.id = data.userId || nanoid();
                user.name = data.name || 'Player';
                ws.send(JSON.stringify({ type: 'hello_ack', userId: user.id }));
                broadcastLobby();
                return;
            }

            if (data.type === 'createRoom') {
                const roomId = nanoid(6);
                const room = {
                    id: roomId,
                    name: data.name,
                    password: data.password,
                    maxPlayers: data.maxPlayers,
                    hostId: user.id,
                    hostName: user.name,
                    inviteKey: nanoid(8),
                    players: new Map(),
                    game: null
                };
                room.players.set(user.id, { id: user.id, name: user.name });
                rooms.set(roomId, room);
                user.roomId = roomId;
                broadcastLobby();
                broadcastRoom(room);
                return;
            }

            if (data.type === 'joinRoom') {
                const room = rooms.get(data.roomId);
                if (!room) return ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
                
                if (room.players.size >= room.maxPlayers) return ws.send(JSON.stringify({ type: 'error', message: 'Full' }));
                
                const isInvite = data.inviteKey === room.inviteKey;
                if (!isInvite && room.password && room.password !== data.password) return ws.send(JSON.stringify({ type: 'error', message: 'Wrong password' }));
                
                room.players.set(user.id, { id: user.id, name: user.name });
                user.roomId = room.id;
                broadcastLobby();
                broadcastRoom(room);
                if (room.game) broadcastGameState(room);
                return;
            }

            if (data.type === 'startGame') {
                const room = rooms.get(user.roomId);
                if (room && room.hostId === user.id) {
                    if (room.players.size < 5) return ws.send(JSON.stringify({type:'error', message: 'Min 5 players'}));
                    initGame(room);
                    broadcastGameState(room);
                }
                return;
            }
            
            if (data.type === 'leaveRoom') {
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
                return;
            }

            if (data.type === 'action') {
                const room = rooms.get(user.roomId);
                if (!room || !room.game) return;
                const game = room.game;
                const me = game.players.find(p => p.id === user.id);
                if (!me) return;
                const act = data.action;

                // --- Confirm Role ---
                if (act.name === 'confirmRole') {
                    if (game.phase === 'roleReveal') {
                        me.confirmedRole = true;
                        if (checkAllRolesConfirmed(game)) {
                            broadcastGameState(room);
                        } else {
                            // Send update so user sees "Waiting"
                            broadcastGameState(room);
                        }
                    }
                    return;
                }

                // --- Discussion ---
                if (act.name === 'passTurn' || act.name === 'passTurnLeaderDiscussion') {
                    const isCurrent = game.players[game.currentPlayerIndex].id === user.id;
                    const isHost = room.hostId === user.id;
                    if (isCurrent || isHost) {
                        game.discussionTimeLeft = 0; // Force timer end logic in next loop tick
                        // Or process immediately
                        game.discussionTurnCount++;
                        if (game.discussionTurnCount >= game.players.length) {
                             if (game.phase === 'leaderDiscussion') {
                                 game.phase = 'missionTeamSelection';
                                 game.nominationTimeLeft = 80;
                             } else {
                                 finalizeDiscussion(game);
                             }
                        } else {
                             game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
                             game.discussionTimeLeft = 40;
                        }
                        broadcastGameState(room);
                    }
                    return;
                }

                // --- Nomination ---
                if (act.name === 'nominate') {
                   if (game.phase === 'discussion' || game.phase === 'nomination') {
                       const target = act.target;
                       if (game.nominatedPlayers.includes(target)) {
                           // Remove if self-nominated or just remove logic?
                           // Prompt: "снять выдвижение"
                           game.nominatedPlayers = game.nominatedPlayers.filter(n => n !== target);
                           const p = game.players.find(p => p.name === target);
                           if (p) p.nominated = false;
                       } else {
                           game.nominatedPlayers.push(target);
                           const p = game.players.find(p => p.name === target);
                           if (p) p.nominated = true;
                       }
                       broadcastGameState(room);
                   }
                   return;
                }

                // --- Voting ---
                if (act.name === 'voteForLeader') {
                    if (game.phase === 'voting' && !me.voted) {
                        // Check if valid candidate (for tie breaker)
                        if (game.tieCandidates.length > 0 && !game.tieCandidates.includes(act.candidate)) return;
                        
                        me.voted = true;
                        game.votes[me.id] = act.candidate;
                        
                        const allVoted = game.players.every(p => p.voted);
                        if (allVoted) processLeaderVote(game);
                        broadcastGameState(room);
                    }
                    return;
                }

                // --- Team Selection ---
                if (act.name === 'toggleTeamMember') {
                    if (game.phase === 'missionTeamSelection' && me.isLeader) {
                        const target = act.target;
                        const size = game.missionSizes[game.currentMission - 1];
                        if (game.missionTeam.includes(target)) {
                            game.missionTeam = game.missionTeam.filter(t => t !== target);
                        } else {
                            if (game.missionTeam.length < size) game.missionTeam.push(target);
                        }
                        broadcastGameState(room);
                    }
                    return;
                }
                
                if (act.name === 'approveTeam') {
                    if (game.phase === 'missionTeamSelection' && me.isLeader) {
                        const size = game.missionSizes[game.currentMission - 1];
                        if (game.missionTeam.length === size) {
                            game.phase = 'missionVoting';
                            broadcastGameState(room);
                        }
                    }
                    return;
                }

                // --- Mission Voting ---
                if (act.name === 'voteForMission') {
                    if (game.phase === 'missionVoting' && game.missionTeam.includes(me.name) && me.missionVote === null) {
                        // Resistance check
                        if (me.role === 'resistance' && act.vote === 'fail') return; // Cheat prevention
                        
                        me.missionVote = act.vote;
                        game.missionVotes[me.id] = act.vote;
                        
                        const teamSize = game.missionTeam.length;
                        const votesCast = Object.keys(game.missionVotes).length;
                        
                        if (votesCast === teamSize) {
                            // Calc result
                            let failCount = 0;
                            Object.values(game.missionVotes).forEach(v => { if (v === 'fail') failCount++; });
                            let successCount = teamSize - failCount;
                            
                            // Rule for 4th mission (index 3) at 7+ players
                            const isMission4 = game.currentMission === 4; // Index 3
                            const playersCount = game.players.length;
                            const needsTwoFails = (playersCount >= 7 && isMission4);
                            
                            let isSuccess = failCount === 0;
                            if (needsTwoFails) isSuccess = failCount < 2;
                            
                            game.missionResults.push({
                                mission: game.currentMission,
                                success: isSuccess,
                                failCount,
                                successCount
                            });
                            
                            if (isSuccess) game.successfulMissions++;
                            else game.failedMissions++;
                            
                            if (game.successfulMissions >= 3) {
                                game.gameOver = true;
                                game.winner = 'resistance';
                            } else if (game.failedMissions >= 3) {
                                game.gameOver = true;
                                game.winner = 'spy';
                            }
                            
                            game.phase = 'missionResults';
                            broadcastGameState(room);
                        } else {
                            broadcastGameState(room);
                        }
                    }
                    return;
                }

                if (act.name === 'nextMission') {
                    if (game.phase === 'missionResults' && !game.gameOver) {
                        nextMission(game);
                        broadcastGameState(room);
                    }
                    return;
                }
            }

        } catch (e) {
            console.error(e);
        }
    });
    
    ws.on('close', () => {
        const u = sockets.get(ws);
        if (u && u.roomId) {
            const r = rooms.get(u.roomId);
            if (r) {
                r.players.delete(u.id);
                if (r.players.size === 0) rooms.delete(r.id);
                else broadcastRoom(r);
            }
        }
        sockets.delete(ws);
        broadcastLobby();
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log('Server running on ' + PORT));
