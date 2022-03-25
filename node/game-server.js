console.log("Running game-server.js.");

const ws = require('ws');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const mysql = require('mysql2/promise');

const messageTypes = {
    AUTHENTICATOR: 0,
    MOVE: 1
};

const responseTypes = {
    AUTHENTICATED: 0,
    PLAYERS: 1,
    ERROR: 2
};
const gameServer = new ws.WebSocketServer({
    port: 3002,
    clientTracking: true
});

const paths = JSON.parse(fs.readFileSync('../config/paths.json'));
const publicKeyRS256 = fs.readFileSync(paths.publicKeyRS256);
const sensitiveData = JSON.parse(fs.readFileSync(paths.sensitiveData));

let connection;
let players = {};

(async () => {
    connection = await mysql.createConnection({
        socketPath: paths.mySQLSocketPath,
        host: 'localhost',
        user: sensitiveData.dbUsername,
        password: sensitiveData.dbPassword,
        database: 'mafia',
        charset: 'utf8mb4'
    });

    connection.connect(err => {
        if (err) {
            console.log("MySQL connection failed: " + err);
        }
    });
})();

function heartbeat() {
    this.isAlive = true;
}

const sessions = new Map();

gameServer.on('upgrade', res => {

})
gameServer.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    sessions.set(
        ws,
        {
            "authenticated": false
        }
    );
    ws.on('message', async data => {
        let userState = sessions.get(ws);
        let message = JSON.parse(data);
        switch (message.type) {
            case messageTypes.AUTHENTICATOR:
                try {
                    const payload = jwt.verify(message.payload, publicKeyRS256);
                    userState.authenticated = true;
                    userState.name = payload.sub;
                    userState.id = await getId(userState.name);
                    players[userState.name] = [0, 0];
                    sessions.forEach((state, wsConn) => {
                        if (state.name == userState.name && ws != wsConn) {
                            wsConn.close(1008, "Another login detected.");
                        }
                        wsConn.send(JSON.stringify({
                            "type": responseTypes.PLAYERS,
                            "payload": players
                        }));
                    });
                } catch (err) {
                    console.log(err);
                    console.log(message);
                }
                break;
            case messageTypes.MOVE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to move while unauthenticated.");
                    break;
                }

                let xPos = players[userState.name][0];
                let yPos = players[userState.name][1];

                switch (message.payload) {
                    case "LEFT":
                        players[userState.name] = [Math.max(0, xPos-1), yPos];
                        break;
                    case "RIGHT":
                        players[userState.name] = [Math.min(20, xPos+1), yPos];
                        break;
                    case "UP":
                        players[userState.name] = [xPos, Math.max(0, yPos-1)];
                        break;
                    case "DOWN":
                        players[userState.name] = [xPos, Math.min(20, yPos+1)];
                        break;
                    default:
                        ws.close(1008, "Received invalid direction: " + message.payload);
                }
                sessions.forEach((state, wsConn) => {
                    wsConn.send(JSON.stringify({
                        "type": responseTypes.PLAYERS,
                        "payload": players
                    }));
                });
                break;
            default:
                ws.close(1008, "Received payload of invalid type: " + message.type);
        }
    });

    ws.on('close', () => {
        delete players[sessions.get(ws).name];
        sessions.delete(ws);
        ws.send(JSON.stringify({
            "type": responseTypes.PLAYERS,
            "payload": players
        }));
    });
})

const interval = setInterval(() => {
    gameServer.clients.forEach(ws => {
        if (!ws.isAlive) {
            ws.terminate();
        } else {
            ws.isAlive = false;
            ws.ping();
        }
    });
}, 10000);

gameServer.on('close', () => {
    clearInterval(interval);
});

async function getId(username) {
    const query = `SELECT id
    FROM user
    WHERE username = ?;`;
    const [results, fields] = await connection.execute(query, [username]);
    if (!results.length) {
        return false;
    }
    return results[0].id;
}