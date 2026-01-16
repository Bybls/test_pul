
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

// In-memory state
const rooms = new Map(); // roomId -> { id, name, hostId, hostName, maxPlayers, passwordHash?, createdAt, players: Map<playerId, player>, game?: {...} }
const sockets = new Map(); // socket -> { id, name, roomId? }

function cleanRoomIfEmpty(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.players.size === 0) {
    rooms.delete(roomId);
  }
}

function publicRoomInfo(room) {
  return {
    id: room.id,
    name: room.name,
    host: room.hostName,
    hostId: room.hostId,
    players: room.players.size,
    maxPlayers: room.maxPlayers,
    hasPassword: !!room.password,
    createdAt: room.createdAt
  };
}

function broadcastLobby() {
  const list = Array.from(rooms.values()).map(publicRoomInfo);
  for (const [ws, user] of sockets.entries()) {
    try {
      ws.send(JSON.stringify({ type: 'lobby', rooms: list }));
    } catch (e) {}
  }
}

function broadcastToRoomRaw(roomId, payload) {
  for (const [ws, user] of sockets.entries()) {
    if (user.roomId === roomId) {
      try { ws.send(JSON.stringify(payload)); } catch (e) {}
    }
  }
}

function broadcastGameState(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.game) return;

  const spies = room.game.players.filter(p => p.role === 'spy');
  const spyPublic = spies.map(s => ({ id: s.id, name: s.name, spyNumber: s.spyNumber }));

  for (const [ws, user] of sockets.entries()) {
    if (user.roomId === roomId) {
      const me = room.game.players.find(p => p.id === user.id);
      const isSpy = me?.role === 'spy';
      const safeGame = safeGameForClient(room.game, user.id, isSpy, spyPublic);
      
      const payload = { type: 'game', game: safeGame, you: me };
      if (isSpy) payload.spies = spyPublic;
      
      try { ws.send(JSON.stringify(payload)); } catch (e) {}
    }
  }
}

function getMissionSizes(count) {
  switch (parseInt(count)) {
    case 5: return [2,3,2,3,3];
    case 6: return [2,3,4,3,4];
    case 7: return [2,3,4,3,4];
    case 8: return [3,4,5,4,5];
    case 9: return [3,4,4,5,5];
    default: return [2,3,4,3,4];
  }
}

function getSpyCount(count) {
  switch (parseInt(count)) {
    case 5: return 2;
    case 6: return 2;
    case 7: return 3;
    case 8: return 3;
    case 9: return 3;
    default: return 2;
  }
}

function assignRoles(playersArr) {
  const count = playersArr.length;
  const spyCount = getSpyCount(count);
  const shuffled = [...playersArr].sort(() => Math.random() - 0.5);
  const spies = new Set(shuffled.slice(0, spyCount).map(p => p.id));
  let spyNumber = 1;
  for (const p of playersArr) {
    if (spies.has(p.id)) {
      p.role = 'spy';
      p.spyNumber = spyNumber++;
    } else {
      p.role = 'resistance';
      p.spyNumber = null;
    }
    p.isLeader = false;
    p.nominated = false;
    p.voted = false;
    p.missionVote = null;
  }
}

function initGame(room) {
  const playersArr = Array.from(room.players.values());
  assignRoles(playersArr);

  const missionSizes = getMissionSizes(playersArr.length);
  const startingIndex = Math.floor(Math.random() * playersArr.length);
  playersArr[startingIndex].isLeader = true;

  room.game = {
    players: playersArr.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      spyNumber: p.spyNumber,
      isLeader: p.isLeader,
      nominated: false,
      voted: false,
      missionVote: null
    })),
    currentMission: 1,
    missionSizes,
    successfulMissions: 0,
    failedMissions: 0,
    currentLeaderIndex: startingIndex,
    currentPlayerIndex: startingIndex,
    discussionTurnCount: 0,
    phase: 'discussion',
    discussionTimeLeft: 40,
    nominationTimeLeft: 80,
    tieTimeLeft: 30,
    nominatedPlayers: [],
    votes: {},
    missionTeam: [],
    missionVotes: {},
    missionResults: [],
    gameOver: false,
    winner: null,
    isTieBreakerVote: false,
    tieCandidates: []
  };
}

function safeGameForClient(game, forPlayerId, isViewerSpy, spiesList) {
  if (!game) return null;
  const copy = JSON.parse(JSON.stringify(game));
  copy.players = copy.players.map(p => {
    if (p.id === forPlayerId) return p;
    const masked = { ...p, role: 'unknown', spyNumber: null };
    if (isViewerSpy && spiesList?.some(s => s.id === p.id)) {
      return masked;
    }
    return masked;
  });
  return copy;
}

// Logic to end discussion and transition to next phase
function finalizeDiscussionPhase(game) {
  const candidateCount = (game.nominatedPlayers || []).length;
  game.players.forEach(p => p.isLeader = false); // Clear previous leader flags

  if (candidateCount === 0) {
      // No candidates: Current leader (starter) becomes leader
      const fallback = game.players[game.currentLeaderIndex];
      if (fallback) fallback.isLeader = true;
      game.phase = 'leaderDiscussion';
  } else if (candidateCount === 1) {
      // 1 candidate: Auto-win
      const winnerName = game.nominatedPlayers[0];
      const winner = game.players.find(p => p.name === winnerName);
      if (winner) winner.isLeader = true;
      game.phase = 'leaderDiscussion';
  } else {
      // 2+ candidates: Vote
      game.phase = 'voting';
      game.isTieBreakerVote = false;
  }

  // Init Leader Discussion if transitioned
  if (game.phase === 'leaderDiscussion') {
      const leaderIdx = game.players.findIndex(p => p.isLeader);
      if (leaderIdx !== -1) {
          game.currentLeaderIndex = leaderIdx;
          game.currentPlayerIndex = leaderIdx;
      }
      game.discussionTurnCount = 0;
      game.discussionTimeLeft = 40;
  }
}

// --- Game Loop for Timers ---
setInterval(() => {
  rooms.forEach((room) => {
    if (!room.game || room.game.gameOver) return;
    const game = room.game;
    let changed = false;

    // Timer logic
    if (game.phase === 'discussion') {
      if (game.discussionTimeLeft > 0) {
        game.discussionTimeLeft--;
        changed = true;
      } else {
        game.discussionTurnCount = (game.discussionTurnCount || 0) + 1;
        if (game.discussionTurnCount >= game.players.length) {
            finalizeDiscussionPhase(game);
        } else {
            game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
            game.discussionTimeLeft = 40;
        }
        changed = true;
      }
    } else if (game.phase === 'leaderDiscussion') {
        if (game.discussionTimeLeft > 0) {
          game.discussionTimeLeft--;
          changed = true;
        } else {
          game.discussionTurnCount = (game.discussionTurnCount || 0) + 1;
          if (game.discussionTurnCount >= game.players.length) {
              game.phase = 'missionTeamSelection';
              game.nominationTimeLeft = 80;
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
        game.missionResults.push({ 
            mission: game.currentMission, 
            success: false, 
            failCount: 0, 
            note: 'Время вышло' 
        });
        game.failedMissions++;
        
        if (game.failedMissions >= 3) {
            game.gameOver = true;
            game.winner = 'spy';
            game.phase = 'missionResults';
        } else {
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

            const nextIndex = (game.currentLeaderIndex + 1) % game.players.length;
            game.players[nextIndex].isLeader = true;
            game.currentLeaderIndex = nextIndex;
            game.currentPlayerIndex = nextIndex;
            game.discussionTurnCount = 0;
            
            game.phase = 'discussion';
            game.discussionTimeLeft = 40;
        }
        changed = true;
      }
    } else if (game.phase === 'tieDiscussion') {
      if (game.tieTimeLeft > 0) {
        game.tieTimeLeft--;
        changed = true;
      } else {
        game.players.forEach(p => p.voted = false);
        game.votes = {};
        game.phase = 'voting';
        // IMPORTANT: We do NOT reset isTieBreakerVote here, it remains true
        changed = true;
      }
    }

    if (changed) {
      broadcastGameState(room.id);
    }
  });
}, 1000);

wss.on('connection', (ws) => {
  const user = { id: null, name: null, roomId: null };
  sockets.set(ws, user);

  ws.on('message', (msg) => {
    let data = null;
    try { data = JSON.parse(msg); } catch (e) { return; }

    if (data.type === 'hello') {
      user.id = data.userId || nanoid();
      user.name = data.name || `Игрок-${user.id.slice(0,4)}`;
      ws.send(JSON.stringify({ type: 'lobby', rooms: Array.from(rooms.values()).map(publicRoomInfo), you: { id: user.id, name: user.name } }));
      return;
    }

    if (data.type === 'createRoom') {
      const { name, maxPlayers, password } = data;
      const roomId = nanoid(10);
      const inviteKey = nanoid(8);
      const room = {
        id: roomId,
        inviteKey,
        name: name || `Игра ${user.name}`,
        hostId: user.id,
        hostName: user.name,
        maxPlayers: Math.max(5, Math.min(9, parseInt(maxPlayers) || 8)),
        password: password ? String(password) : null,
        createdAt: Date.now(),
        players: new Map()
      };
      rooms.set(roomId, room);
      room.players.set(user.id, { id: user.id, name: user.name });
      user.roomId = roomId;
      broadcastLobby();
      broadcastToRoomRaw(roomId, { type: 'room', room: { ...publicRoomInfo(room), inviteKey }, players: Array.from(room.players.values()) });
      return;
    }

    if (data.type === 'joinRoom') {
      const room = rooms.get(data.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' })); return; }
      if (room.players.size >= room.maxPlayers) { ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена' })); return; }
      
      const hasInvite = data.inviteKey && room.inviteKey && (String(data.inviteKey) === String(room.inviteKey));
      if (!hasInvite && room.password && room.password !== (data.password || '')) { 
          ws.send(JSON.stringify({ type: 'error', message: 'Неверный пароль' })); 
          return; 
      }
      
      room.players.set(user.id, { id: user.id, name: user.name });
      user.roomId = room.id;
      broadcastLobby();
      broadcastToRoomRaw(room.id, { type: 'room', room: { ...publicRoomInfo(room), inviteKey: room.inviteKey }, players: Array.from(room.players.values()) });
      return;
    }

    if (data.type === 'leaveRoom') {
      const room = rooms.get(user.roomId);
      if (room) {
        room.players.delete(user.id);
        broadcastToRoomRaw(room.id, { type: 'room', room: publicRoomInfo(room), players: Array.from(room.players.values()) });
        if (room.hostId === user.id) {
          const next = Array.from(room.players.values())[0];
          if (next) {
            room.hostId = next.id;
            room.hostName = next.name;
          }
        }
        if (room.players.size === 0) rooms.delete(room.id);
      }
      user.roomId = null;
      broadcastLobby();
      return;
    }

    if (data.type === 'getLobby') {
      ws.send(JSON.stringify({ type: 'lobby', rooms: Array.from(rooms.values()).map(publicRoomInfo) }));
      return;
    }

    if (data.type === 'startGame') {
      const room = rooms.get(user.roomId);
      if (!room) return;
      if (room.hostId !== user.id) return;
      if (room.players.size < 5) { ws.send(JSON.stringify({ type: 'error', message: 'Нужно минимум 5 игроков' })); return; }
      initGame(room);
      broadcastGameState(room.id);
      broadcastToRoomRaw(room.id, { type: 'room', room: { ...publicRoomInfo(room), inviteKey: room.inviteKey }, players: Array.from(room.players.values()) });
      return;
    }

    if (data.type === 'action' && user.roomId) {
      const room = rooms.get(user.roomId);
      if (!room || !room.game) return;
      const game = room.game;
      const me = game.players.find(p => p.id === user.id);
      if (!me) return;

      const a = data.action;

      if (a.name === 'passTurn') {
        const isCurrentPlayer = game.players[game.currentPlayerIndex].id === user.id;
        const isHost = room.hostId === user.id;
        
        if (isCurrentPlayer || isHost) {
           game.discussionTurnCount = (game.discussionTurnCount || 0) + 1;
           
           if (game.discussionTurnCount >= game.players.length) {
             finalizeDiscussionPhase(game);
           } else {
             game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
             game.discussionTimeLeft = 40;
           }
           broadcastGameState(room.id);
        }
        return;
      }

      if (a.name === 'nominateSelf') {
        if (!me.nominated) {
          me.nominated = true;
          if (!game.nominatedPlayers.includes(me.name)) game.nominatedPlayers.push(me.name);
          broadcastGameState(room.id);
        }
        return;
      }

      if (a.name === 'nominateOther') {
        const other = game.players.find(p => p.name === a.playerName);
        if (other && !game.nominatedPlayers.includes(other.name)) {
          game.nominatedPlayers.push(other.name);
          broadcastGameState(room.id);
        }
        return;
      }

      if (a.name === 'removeNomination') {
        game.nominatedPlayers = game.nominatedPlayers.filter(n => n !== a.playerName);
        const p = game.players.find(p => p.name === a.playerName);
        if (p) p.nominated = false;
        broadcastGameState(room.id);
        return;
      }

      if (a.name === 'voteForLeader') {
        if (!me.voted) {
          me.voted = true;
          game.votes[me.id] = a.playerName;
          const allVoted = game.players.every(p => p.voted);
          
          if (allVoted) {
            const counts = {};
            for (const name of Object.values(game.votes)) counts[name] = (counts[name] || 0) + 1;
            let max = 0; let winners = [];
            for (const [name, c] of Object.entries(counts)) {
              if (c > max) { max = c; winners = [name]; }
              else if (c === max) { winners.push(name); }
            }
            if (winners.length === 0) {
              const fallback = game.players[game.currentPlayerIndex]?.name || game.players[game.currentLeaderIndex]?.name;
              winners = [fallback];
            }

            if (winners.length > 1) {
              // TIE DETECTED
              if (game.isTieBreakerVote) {
                  // Second tie -> Force resolve by starter vote
                  const starter = game.players[game.currentLeaderIndex];
                  const starterVote = game.votes[starter.id];
                  // If starter voted for one of the tied winners, they win. Else fallback to first winner.
                  const finalWinnerName = winners.includes(starterVote) ? starterVote : winners[0];
                  
                  game.players.forEach(p => p.isLeader = false);
                  const leader = game.players.find(p => p.name === finalWinnerName);
                  if (leader) leader.isLeader = true;
                  
                  game.phase = 'leaderDiscussion';
                  const leaderIdx = game.players.indexOf(leader);
                  game.currentLeaderIndex = leaderIdx;
                  game.currentPlayerIndex = leaderIdx;
                  game.discussionTurnCount = 0;
                  game.discussionTimeLeft = 40;
              } else {
                  // First tie -> Go to tie discussion
                  game.tieCandidates = winners;
                  game.phase = 'tieDiscussion';
                  game.tieTimeLeft = 30 * winners.length; // Total time? Or per person? 
                  // Prompt says "поочередно дается по 30 секунд". 
                  // We'll simplify server side: give total time block, client logic handles turns or just open floor.
                  // For simplicity in this text-based interaction, let's just give a block of time.
                  game.isTieBreakerVote = true;
              }
            } else {
              const winName = winners[0];
              game.players.forEach(p => p.isLeader = false);
              const leader = game.players.find(p => p.name === winName);
              if (leader) {
                leader.isLeader = true;
                game.currentLeaderIndex = game.players.indexOf(leader);
                game.currentPlayerIndex = game.currentLeaderIndex;
                game.discussionTurnCount = 0;
                game.phase = 'leaderDiscussion';
                game.discussionTimeLeft = 40;
              }
            }
          }
          broadcastGameState(room.id);
        }
        return;
      }

      if (a.name === 'passTurnLeaderDiscussion') {
         const isCurrentPlayer = game.players[game.currentPlayerIndex].id === user.id;
         const isHost = room.hostId === user.id;
         
         if (isCurrentPlayer || isHost) {
            game.discussionTurnCount = (game.discussionTurnCount || 0) + 1;
            
            if (game.discussionTurnCount >= game.players.length) {
              game.phase = 'missionTeamSelection';
              game.nominationTimeLeft = 80;
            } else {
              game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
              game.discussionTimeLeft = 40;
            }
            broadcastGameState(room.id);
         }
         return;
      }

      if (a.name === 'startMissionTeamSelection') {
        if (me.isLeader) {
          game.phase = 'missionTeamSelection';
          game.nominationTimeLeft = 80;
          broadcastGameState(room.id);
        }
        return;
      }

      if (a.name === 'addToMissionTeam') {
        if (me.isLeader) {
          const missionSize = game.missionSizes[game.currentMission - 1];
          if (!game.missionTeam.includes(a.playerName) && game.missionTeam.length < missionSize) {
            game.missionTeam.push(a.playerName);
            broadcastGameState(room.id);
          }
        }
        return;
      }

      if (a.name === 'removeFromMissionTeam') {
        if (me.isLeader) {
          game.missionTeam = game.missionTeam.filter(n => n !== a.playerName);
          broadcastGameState(room.id);
        }
        return;
      }

      if (a.name === 'resetMissionTeam') {
        if (me.isLeader) {
          game.missionTeam = [];
          broadcastGameState(room.id);
        }
        return;
      }

      if (a.name === 'approveMissionTeam') {
        if (me.isLeader) {
          const missionSize = game.missionSizes[game.currentMission - 1];
          if (game.missionTeam.length === missionSize) {
            game.phase = 'missionVoting';
            broadcastGameState(room.id);
          }
        }
        return;
      }

      if (a.name === 'voteForMission') {
        const isInMission = game.missionTeam.includes(me.name);
        if (!isInMission) return;
        if (me.missionVote === null) {
          me.missionVote = a.vote;
          game.missionVotes[me.id] = a.vote;
          const participants = game.players.filter(p => game.missionTeam.includes(p.name));
          const allVoted = participants.every(p => p.missionVote !== null);
          if (allVoted) {
            let successCount = 0, failCount = 0;
            for (const p of participants) {
              if (p.missionVote === 'success') successCount++; else if (p.missionVote === 'fail') failCount++;
            }
            const playerCount = game.players.length;
            const isMission3 = game.currentMission === 3;
            const needsTwoFails = isMission3 && [7,8,9].includes(playerCount);
            const missionSuccess = needsTwoFails ? (failCount < 2) : (failCount === 0);

            game.missionResults.push({ mission: game.currentMission, success: missionSuccess, successCount, failCount });
            if (missionSuccess) game.successfulMissions++; else game.failedMissions++;
            
            if (game.successfulMissions >= 3 || game.failedMissions >= 3) {
              game.gameOver = true;
              game.winner = game.successfulMissions >= 3 ? 'resistance' : 'spy';
            }
            game.phase = 'missionResults';
          }
          broadcastGameState(room.id);
        }
        return;
      }

      if (a.name === 'startNextMission') {
        game.currentMission++;
        game.players.forEach(p => { p.nominated = false; p.voted = false; p.missionVote = null; p.isLeader = false; });
        game.nominatedPlayers = [];
        game.votes = {};
        game.missionTeam = [];
        game.missionVotes = {};
        game.isTieBreakerVote = false;
        game.tieCandidates = [];

        const nextIndex = (game.currentLeaderIndex + 1) % game.players.length;
        game.players[nextIndex].isLeader = true;
        game.currentLeaderIndex = nextIndex;
        game.currentPlayerIndex = nextIndex; 
        game.discussionTurnCount = 0;
        game.phase = 'discussion';
        game.discussionTimeLeft = 40;
        broadcastGameState(room.id);
        return;
      }

      if (a.name === 'tieRevote') {
        game.players.forEach(p => p.voted = false);
        game.votes = {};
        game.phase = 'voting';
        broadcastGameState(room.id);
        return;
      }
    }
  });

  ws.on('close', () => {
    const u = sockets.get(ws);
    if (u) {
      const room = rooms.get(u.roomId);
      if (room) {
        room.players.delete(u.id);
        broadcastToRoomRaw(room.id, { type: 'room', room: publicRoomInfo(room), players: Array.from(room.players.values()) });
        cleanRoomIfEmpty(u.roomId);
      }
      sockets.delete(ws);
    }
  });
});

app.get('/api/rooms', (req, res) => {
  res.json(Array.from(rooms.values()).map(publicRoomInfo));
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
