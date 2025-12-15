const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const teams = new Map();
let adminWs = null;

const GENRES = ['Ex-Yu', 'Rep', 'Narodna', 'Pop', 'Turbo Folk'];

let tournament = {
  started: false,
  bracket: {
    quarterfinals: [
      { team1: null, team2: null, winner: null, active: false },
      { team1: null, team2: null, winner: null, active: false },
      { team1: null, team2: null, winner: null, active: false },
      { team1: null, team2: null, winner: null, active: false }
    ],
    semifinals: [
      { team1: null, team2: null, winner: null, active: false },
      { team1: null, team2: null, winner: null, active: false }
    ],
    final: { team1: null, team2: null, winner: null, active: false, score1: 0, score2: 0 }
  },
  currentMatch: null,
  phase: 'waiting'
};

let gameState = {
  genre: null,
  buzzedTeam: null,
  buzzTime: null,
  canBuzz: [],
  startTime: null,
  currentAnswerer: null
};

const server = http.createServer((req, res) => {
  let filePath = '';
  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else if (req.url === '/admin') {
    filePath = path.join(__dirname, 'admin.html');
  } else {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Error loading page');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function broadcast(message) {
  const msg = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

function sendToTeam(teamName, message) {
  const team = teams.get(teamName);
  if (team && team.ws && team.ws.readyState === 1) {
    team.ws.send(JSON.stringify(message));
  }
}

function sendToAdmin(message) {
  if (adminWs && adminWs.readyState === 1) {
    adminWs.send(JSON.stringify(message));
  }
}

function broadcastTeamList() {
  const teamList = Array.from(teams.keys());
  broadcast({ type: 'teams', teams: teamList, count: teamList.length });
}

function broadcastTournamentState() {
  broadcast({ 
    type: 'tournament-state', 
    tournament,
    gameState: {
      genre: gameState.genre,
      buzzedTeam: gameState.buzzedTeam,
      currentAnswerer: gameState.currentAnswerer,
      phase: tournament.phase
    }
  });
}

function getCurrentMatch() {
  if (!tournament.currentMatch) return null;
  const { round, index } = tournament.currentMatch;
  if (round === 'final') {
    return tournament.bracket.final;
  }
  return tournament.bracket[round][index];
}

function getOtherTeam(teamName) {
  const match = getCurrentMatch();
  if (!match) return null;
  return match.team1 === teamName ? match.team2 : match.team1;
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function initializeBracket() {
  const teamNames = shuffleArray(Array.from(teams.keys()));
  
  for (let i = 0; i < 4; i++) {
    tournament.bracket.quarterfinals[i].team1 = teamNames[i * 2];
    tournament.bracket.quarterfinals[i].team2 = teamNames[i * 2 + 1];
    tournament.bracket.quarterfinals[i].winner = null;
    tournament.bracket.quarterfinals[i].active = false;
  }
  
  tournament.bracket.semifinals.forEach(m => {
    m.team1 = null;
    m.team2 = null;
    m.winner = null;
    m.active = false;
  });
  tournament.bracket.final = { team1: null, team2: null, winner: null, active: false, score1: 0, score2: 0 };
}

function advanceWinners() {
  const qf = tournament.bracket.quarterfinals;
  if (qf[0].winner && qf[1].winner) {
    tournament.bracket.semifinals[0].team1 = qf[0].winner;
    tournament.bracket.semifinals[0].team2 = qf[1].winner;
  }
  if (qf[2].winner && qf[3].winner) {
    tournament.bracket.semifinals[1].team1 = qf[2].winner;
    tournament.bracket.semifinals[1].team2 = qf[3].winner;
  }
  
  const sf = tournament.bracket.semifinals;
  if (sf[0].winner && sf[1].winner) {
    tournament.bracket.final.team1 = sf[0].winner;
    tournament.bracket.final.team2 = sf[1].winner;
  }
}

wss.on('connection', (ws) => {
  let teamName = null;
  let isAdmin = false;

  ws.on('message', (data) => {
    const message = JSON.parse(data);

    switch (message.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'admin-join':
        isAdmin = true;
        adminWs = ws;
        ws.send(JSON.stringify({ type: 'teams', teams: Array.from(teams.keys()), count: teams.size }));
        ws.send(JSON.stringify({ type: 'genres', genres: GENRES }));
        broadcastTournamentState();
        break;

      case 'team-join':
        teamName = message.name;
        if (teams.has(teamName)) {
          const existingTeam = teams.get(teamName);
          if (existingTeam.ws !== ws && existingTeam.ws.readyState === 1) {
            existingTeam.ws.close();
          }
        }
        teams.set(teamName, { ws, id: Date.now() });
        ws.send(JSON.stringify({ type: 'joined', name: teamName }));
        broadcastTeamList();
        broadcastTournamentState();
        break;

      case 'start-tournament':
        if (!isAdmin || teams.size !== 8) return;
        tournament.started = true;
        tournament.phase = 'waiting';
        initializeBracket();
        broadcastTournamentState();
        break;

      case 'reset-tournament':
        if (!isAdmin) return;
        tournament = {
          started: false,
          bracket: {
            quarterfinals: [
              { team1: null, team2: null, winner: null, active: false },
              { team1: null, team2: null, winner: null, active: false },
              { team1: null, team2: null, winner: null, active: false },
              { team1: null, team2: null, winner: null, active: false }
            ],
            semifinals: [
              { team1: null, team2: null, winner: null, active: false },
              { team1: null, team2: null, winner: null, active: false }
            ],
            final: { team1: null, team2: null, winner: null, active: false, score1: 0, score2: 0 }
          },
          currentMatch: null,
          phase: 'waiting'
        };
        gameState = { genre: null, buzzedTeam: null, buzzTime: null, canBuzz: [], startTime: null, currentAnswerer: null };
        broadcastTournamentState();
        break;

      case 'select-match':
        if (!isAdmin) return;
        const { round, index } = message;
        tournament.currentMatch = { round, index };
        tournament.phase = 'wheel';
        gameState = { genre: null, buzzedTeam: null, buzzTime: null, canBuzz: [], startTime: null, currentAnswerer: null };
        
        const match = getCurrentMatch();
        if (match) match.active = true;
        
        broadcastTournamentState();
        break;

      case 'spin-wheel':
        if (!isAdmin || tournament.phase !== 'wheel') return;
        const randomGenre = GENRES[Math.floor(Math.random() * GENRES.length)];
        gameState.genre = randomGenre;
        broadcast({ type: 'wheel-result', genre: randomGenre });
        break;

      case 'start-round':
        if (!isAdmin) return;
        tournament.phase = 'buzzer';
        const currentMatch = getCurrentMatch();
        if (!currentMatch) return;
        
        gameState.buzzedTeam = null;
        gameState.buzzTime = null;
        gameState.currentAnswerer = null;
        gameState.canBuzz = [currentMatch.team1, currentMatch.team2];
        gameState.startTime = Date.now();
        
        sendToTeam(currentMatch.team1, { type: 'show-button' });
        sendToTeam(currentMatch.team2, { type: 'show-button' });
        
        sendToAdmin({ type: 'round-started' });
        broadcastTournamentState();
        break;

      case 'buzz':
        if (tournament.phase !== 'buzzer' || !gameState.canBuzz.includes(teamName)) return;
        if (gameState.buzzedTeam) return;
        
        gameState.buzzedTeam = teamName;
        gameState.buzzTime = Date.now() - gameState.startTime;
        gameState.currentAnswerer = teamName;
        tournament.phase = 'answering';
        
        const otherTeam = getOtherTeam(teamName);
        
        sendToTeam(teamName, { type: 'you-answer', time: gameState.buzzTime });
        sendToTeam(otherTeam, { type: 'opponent-answers', opponent: teamName });
        sendToAdmin({ type: 'buzzed', team: teamName, time: gameState.buzzTime });
        
        broadcastTournamentState();
        break;

      case 'correct-answer':
        if (!isAdmin || tournament.phase !== 'answering') return;
        const winningTeam = gameState.currentAnswerer;
        const matchForCorrect = getCurrentMatch();
        const losingTeam = getOtherTeam(winningTeam);
        
        if (tournament.currentMatch.round === 'final') {
          if (winningTeam === matchForCorrect.team1) {
            matchForCorrect.score1++;
          } else {
            matchForCorrect.score2++;
          }
          
          if (matchForCorrect.score1 >= 2) {
            matchForCorrect.winner = matchForCorrect.team1;
            matchForCorrect.active = false;
            tournament.phase = 'waiting';
            tournament.currentMatch = null;
            
            sendToTeam(matchForCorrect.team1, { type: 'you-won-tournament' });
            sendToTeam(matchForCorrect.team2, { type: 'you-lost-match', winner: matchForCorrect.team1, isFinal: true });
            sendToAdmin({ type: 'match-winner', winner: matchForCorrect.team1, isFinal: true });
          } else if (matchForCorrect.score2 >= 2) {
            matchForCorrect.winner = matchForCorrect.team2;
            matchForCorrect.active = false;
            tournament.phase = 'waiting';
            tournament.currentMatch = null;
            
            sendToTeam(matchForCorrect.team2, { type: 'you-won-tournament' });
            sendToTeam(matchForCorrect.team1, { type: 'you-lost-match', winner: matchForCorrect.team2, isFinal: true });
            sendToAdmin({ type: 'match-winner', winner: matchForCorrect.team2, isFinal: true });
          } else {
            tournament.phase = 'wheel';
            sendToTeam(winningTeam, { type: 'correct-next-round', score1: matchForCorrect.score1, score2: matchForCorrect.score2 });
            sendToTeam(losingTeam, { type: 'opponent-correct-next-round', score1: matchForCorrect.score1, score2: matchForCorrect.score2 });
            sendToAdmin({ type: 'final-point', team: winningTeam, score1: matchForCorrect.score1, score2: matchForCorrect.score2 });
            gameState = { genre: null, buzzedTeam: null, buzzTime: null, canBuzz: [], startTime: null, currentAnswerer: null };
          }
        } else {
          matchForCorrect.winner = winningTeam;
          matchForCorrect.active = false;
          tournament.phase = 'waiting';
          tournament.currentMatch = null;
          advanceWinners();
          
          sendToTeam(winningTeam, { type: 'you-won-match' });
          sendToTeam(losingTeam, { type: 'you-lost-match', winner: winningTeam, isFinal: false });
          sendToAdmin({ type: 'match-winner', winner: winningTeam, isFinal: false });
        }
        
        broadcastTournamentState();
        break;

      case 'wrong-answer':
        if (!isAdmin || tournament.phase !== 'answering') return;
        const wrongTeam = gameState.currentAnswerer;
        const matchForWrong = getCurrentMatch();
        const otherTeamForAnswer = getOtherTeam(wrongTeam);
        
        if (!gameState.canBuzz.includes(otherTeamForAnswer)) {
          tournament.phase = 'wheel';
          gameState = { genre: null, buzzedTeam: null, buzzTime: null, canBuzz: [], startTime: null, currentAnswerer: null };
          
          sendToTeam(matchForWrong.team1, { type: 'both-wrong-new-song' });
          sendToTeam(matchForWrong.team2, { type: 'both-wrong-new-song' });
          sendToAdmin({ type: 'both-wrong' });
        } else {
          gameState.canBuzz = gameState.canBuzz.filter(t => t !== wrongTeam);
          gameState.currentAnswerer = otherTeamForAnswer;
          
          sendToTeam(wrongTeam, { type: 'you-wrong-wait' });
          sendToTeam(otherTeamForAnswer, { type: 'your-turn-answer' });
          sendToAdmin({ type: 'wrong-other-answers', team: otherTeamForAnswer });
        }
        
        broadcastTournamentState();
        break;

      case 'kick-team':
        if (!isAdmin) return;
        const kickedTeam = teams.get(message.name);
        if (kickedTeam) {
          kickedTeam.ws.send(JSON.stringify({ type: 'kicked' }));
          kickedTeam.ws.close();
          teams.delete(message.name);
          broadcastTeamList();
        }
        break;
    }
  });

  ws.on('close', () => {
    if (teamName && teams.has(teamName)) {
      const team = teams.get(teamName);
      if (team.ws === ws) {
        team.disconnectedAt = Date.now();
        setTimeout(() => {
          const currentTeam = teams.get(teamName);
          if (currentTeam && currentTeam.disconnectedAt && Date.now() - currentTeam.disconnectedAt >= 59000) {
            teams.delete(teamName);
            broadcastTeamList();
          }
        }, 60000);
      }
    }
    if (isAdmin && adminWs === ws) {
      adminWs = null;
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  console.log(`Players join: http://<your-ip>:${PORT}/`);
  
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`Players can connect via: http://${net.address}:${PORT}/`);
      }
    }
  }
});
