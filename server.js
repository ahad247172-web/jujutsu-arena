const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Game State Management
const waitingPlayers = [];
const activeGames = new Map();

class Game {
    constructor(player1, player2) {
        this.id = Date.now().toString(36) + Math.random().toString(36).substr(2);
        this.player1 = player1;
        this.player2 = player2;
        this.p1Char = null;
        this.p2Char = null;
        this.p1State = { x: -3, y: 0, health: 100, inputs: {} };
        this.p2State = { x: 3, y: 0, health: 100, inputs: {} };
        this.started = false;
        this.lastUpdate = Date.now();
        
        player1.gameId = this.id;
        player2.gameId = this.id;
        player1.isHost = true;
        player2.isHost = false;
        
        player1.emit('match-found', {
            gameId: this.id,
            isHost: true,
            opponent: { id: player2.id, name: player2.username || 'Player 2' }
        });
        
        player2.emit('match-found', {
            gameId: this.id,
            isHost: false,
            opponent: { id: player1.id, name: player1.username || 'Player 1' }
        });
        
        // Start game after both select characters
        this.checkStart();
    }
    
    checkStart() {
        if (this.p1Char && this.p2Char) {
            this.started = true;
            this.player1.emit('game-start', { opponentChar: this.p2Char });
            this.player2.emit('game-start', { opponentChar: this.p1Char });
            this.startGameLoop();
        }
    }
    
    startGameLoop() {
        this.gameInterval = setInterval(() => {
            this.update();
        }, 1000 / 60); // 60Hz server tick
    }
    
    update() {
        // Simple physics and collision detection
        const now = Date.now();
        const dt = (now - this.lastUpdate) / 1000;
        this.lastUpdate = now;
        
        // Update positions based on inputs
        this.updatePlayer(this.p1State, dt);
        this.updatePlayer(this.p2State, dt);
        
        // Check collisions
        const dist = Math.abs(this.p1State.x - this.p2State.x);
        if (dist < 1.5) {
            // Handle attacks
            if (this.p1State.inputs.punch) this.applyDamage(this.p2State, 5);
            if (this.p2State.inputs.punch) this.applyDamage(this.p1State, 5);
            if (this.p1State.inputs.kick) this.applyDamage(this.p2State, 10);
            if (this.p2State.inputs.kick) this.applyDamage(this.p1State, 10);
        }
        
        // Sync states
        this.player1.emit('game-state', {
            opponentPosition: { x: this.p2State.x, y: this.p2State.y },
            opponentHealth: this.p2State.health,
            serverTime: now
        });
        
        this.player2.emit('game-state', {
            opponentPosition: { x: this.p1State.x, y: this.p1State.y },
            opponentHealth: this.p1State.health,
            serverTime: now
        });
        
        // Check win condition
        if (this.p1State.health <= 0 || this.p2State.health <= 0) {
            this.endGame();
        }
    }
    
    updatePlayer(state, dt) {
        const speed = 5;
        state.x += (state.inputs.x || 0) * speed * dt;
        state.y += (state.inputs.y || 0) * 10 * dt;
        
        // Gravity
        if (state.y > 0) state.y -= 20 * dt;
        if (state.y < 0) state.y = 0;
        
        // Bounds
        state.x = Math.max(-10, Math.min(10, state.x));
    }
    
    applyDamage(state, dmg) {
        if (!state.inputs.block) {
            state.health = Math.max(0, state.health - dmg);
        }
    }
    
    endGame() {
        clearInterval(this.gameInterval);
        const winner = this.p1State.health > 0 ? 1 : 2;
        this.player1.emit('game-end', { winner });
        this.player2.emit('game-end', { winner });
    }
    
    handleInput(player, data) {
        if (player === this.player1) {
            this.p1State.inputs = data.inputs;
            this.p1State.x = data.position.x;
            this.p1State.y = data.position.y;
            // Forward to opponent for prediction
            this.player2.emit('opponent-input', data);
        } else {
            this.p2State.inputs = data.inputs;
            this.p2State.x = data.position.x;
            this.p2State.y = data.position.y;
            this.player1.emit('opponent-input', data);
        }
    }
}

// Socket Handling
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    socket.on('find-match', () => {
        if (waitingPlayers.length > 0) {
            const opponent = waitingPlayers.shift();
            const game = new Game(opponent, socket);
            activeGames.set(game.id, game);
        } else {
            waitingPlayers.push(socket);
            socket.emit('waiting');
        }
    });
    
    socket.on('cancel-match', () => {
        const idx = waitingPlayers.indexOf(socket);
        if (idx > -1) waitingPlayers.splice(idx, 1);
    });
    
    socket.on('character-selected', (data) => {
        const game = activeGames.get(data.gameId);
        if (game) {
            if (socket === game.player1) game.p1Char = data.character;
            else game.p2Char = data.character;
            game.checkStart();
        }
    });
    
    socket.on('player-input', (data) => {
        const game = activeGames.get(data.gameId);
        if (game && game.started) {
            game.handleInput(socket, data);
        }
    });
    
    socket.on('ping', (data) => {
        socket.emit('pong', data);
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        const idx = waitingPlayers.indexOf(socket);
        if (idx > -1) waitingPlayers.splice(idx, 1);
        
        // Notify opponent
        const game = Array.from(activeGames.values()).find(g => 
            g.player1 === socket || g.player2 === socket
        );
        if (game) {
            const opponent = game.player1 === socket ? game.player2 : game.player1;
            opponent.emit('opponent-disconnected');
            activeGames.delete(game.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
