console.log("Running lobby-server.js.");

const ws = require('ws');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const mysql = require('mysql2/promise');
const { response } = require('express');

const messageTypes = {
    AUTHENTICATOR: 0,
    MESSAGE: 1,
    LEAVE_ROOM: 2,
    CREATE_ROOM: 3,
    JOIN_ROOM: 4
};

const responseTypes = {
    AUTHENTICATED: 0,
    ERROR: 1,
    MESSAGE: 2,
    ROOM: 3,
    ROOMS: 4
};

const lobbyServer = new ws.WebSocketServer({
    port: 3003,
    clientTracking: true
});

const paths = JSON.parse(fs.readFileSync('../config/paths.json'));
const publicKeyRS256 = fs.readFileSync(paths.publicKeyRS256);
const sensitiveData = JSON.parse(fs.readFileSync(paths.sensitiveData));

let connectionPool;

(async () => {
    connectionPool = await mysql.createPool({
        socketPath: paths.mySQLSocketPath,
        host: 'localhost',
        user: sensitiveData.dbUsername,
        password: sensitiveData.dbPassword,
        database: 'mafia',
        charset: 'utf8mb4'
    });
})();

function heartbeat() {
    this.isAlive = true;
}

const sessions = new Map();
const rooms = new Map();
let roomCount = 0; // counter that only increases; used as ID for rooms

lobbyServer.on('upgrade', res => {

})
lobbyServer.on('connection', (ws, req) => {
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
            case messageTypes.AUTHENTICATOR: {
                let payload;
                try {
                    payload = jwt.verify(message.payload, publicKeyRS256);
                    if (payload.aud != "lobby") {
                        ws.close(1008, `Wrong JWT audience: ${payload.aud}. Expected "lobby".`);
                        break;
                    }
                } catch (err) {
                    console.log(err);
                    console.log(message);
                    ws.close(1008, "JWT malformed.");
                }
                userState.authenticated = true;
                userState.name = payload.sub;
                sessions.forEach((state, wsConn) => {
                    if (state.name == userState.name && ws != wsConn) {
                        wsConn.close(1008, "Another login detected.");
                    }
                });
                ws.send(JSON.stringify({
                    "type": responseTypes.AUTHENTICATED
                }));
                sendRoomsUpdate();
                break;
            }
            case messageTypes.MESSAGE: {
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to send message while unauthenticated.");
                    break;
                }

                if (!userState.roomId) {
                    ws.send(JSON.stringify({
                        "type": responseTypes.ERROR,
                        "payload": "Cannot send message when not in a room."
                    }));
                    break;
                }

                let room = rooms.get(userState.roomId);
                let d = new Date();
				let timestamp = d.getHours().toString().padStart(2, '0') + ":" + d.getMinutes().toString().padStart(2, '0');
						
                room.chatHistory.push({
                    "text": message.payload,
                    "author": userState.name,
                    "timestamp": timestamp
                });
                sessions.forEach((state, wsConnection) => {
                    if (state.roomId == userState.roomId) {
                        wsConnection.send(JSON.stringify({
                            "type": responseTypes.ROOM,
                            "payload": room
                        }));
                    }
                });
                break;
            }
            case messageTypes.CREATE_ROOM: {
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to create room while unauthenticated.");
                    break;
                }
                if (userState.roomId) {
                    removeUserFromRoom(userState.roomId);
                }

                userState.roomId = ++roomCount;
                rooms.set(
                    userState.roomId,
                    {
                        "id": userState.roomId,
                        "owner": userState.name,
                        "users": [userState.name],
                        "chatHistory": []
                    }
                );
                sendRoomUpdate(userState.roomId);
                sendRoomsUpdate();
                break;
            }
            case messageTypes.JOIN_ROOM: {
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to create room while unauthenticated.");
                    break;
                }

                if (!rooms.has(message.payload)) {
                    ws.send(JSON.stringify({
                        "type": responseTypes.ERROR,
                        "payload": "Cannot join a room that doesn't exist."
                    }));
                    break;
                }

                if(userState.roomId == message.payload) {
                    ws.send(JSON.stringify({
                        "type": responseTypes.ERROR,
                        "payload": "Already in room."
                    }));
                    break;
                }

                if (userState.roomId) {
                    removeUserFromRoom(userState.roomId, userState.name);
                }

                rooms.get(message.payload).users.push(userState.name);
                userState.roomId = message.payload;
                sendRoomUpdate(userState.roomId);
                break;
            }
            case messageTypes.LEAVE_ROOM: {
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to leave room while unauthenticated.");
                    break;
                }
                removeUserFromRoom(userState.roomId, userState.name);
                let roomId = userState.roomId;                    
                userState.roomId = null;
                sendRoomUpdate(roomId);
                ws.send(JSON.stringify({
                    "type": responseTypes.ROOM,
                    "payload": {}
                }));
                break;
            }
            default:
                ws.close(1008, "Received payload of invalid type: " + message.type);
        }
    });

    ws.on('close', () => {
        let userState = sessions.get(ws);
        removeUserFromRoom(userState.roomId, userState.name);
        sessions.delete(ws);
    });
})

const interval = setInterval(() => {
    lobbyServer.clients.forEach(ws => {
        if (!ws.isAlive) {
            ws.close();
        } else {
            ws.isAlive = false;
            ws.ping();
        }
    });
}, 10000);

lobbyServer.on('close', () => {
    clearInterval(interval);
});

function removeUserFromRoom(roomId, username) {
    let room = rooms.get(roomId);
    if(!room) {
        return false;
    }
    room.users = room.users.filter(name => name != username);

    if (room.users.length == 0) {
        rooms.delete(roomId);
        sendRoomsUpdate();
    }
}

function sendRoomsUpdate() {
    sessions.forEach((state, wsConn) => {
        wsConn.send(JSON.stringify({
            "type": responseTypes.ROOMS,
            "payload": [...rooms.keys()]
        }));
    });
}

function sendRoomUpdate(roomId) {
    sessions.forEach((state, wsConnection) => {
        if (state.roomId == roomId) {
            wsConnection.send(JSON.stringify({
                "type": responseTypes.ROOM,
                "payload": rooms.get(roomId)
            }));
        }
    });
}