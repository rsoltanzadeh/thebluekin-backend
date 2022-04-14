console.log("Running lobby-server.js.");

const ws = require('ws');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const mysql = require('mysql2/promise');

const messageTypes = {
    AUTHENTICATOR: 0,
    MESSAGE: 1
};

const responseTypes = {
    AUTHENTICATED: 0,
    ERROR: 1
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
            case messageTypes.AUTHENTICATOR:
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
                userState.id = await getId(userState.name);
                sessions.forEach((state, wsConn) => {
                    if (state.name == userState.name && ws != wsConn) {
                        wsConn.close(1008, "Another login detected.");
                    }
                });
                ws.send(JSON.stringify({
                    "type": responseTypes.AUTHENTICATED
                }));
                break;
            case messageTypes.MESSAGE:
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

                const text = message.payload.text;
                sessions.forEach((state, wsConnection) => {
                    if (state.roomId == userState.roomId) {
                        wsConnection.send(JSON.stringify({
                            "type": responseTypes.MESSAGE,
                            "payload": {
                                "text": text,
                                "author": userState.name
                            }
                        }));
                        ws.send(JSON.stringify({
                            "type": responseTypes.MESSAGE,
                            "payload": {
                                "text": text,
                                "author": ""
                            }
                        }));
                    }
                });
                break;
            case messageTypes.CREATE_ROOM:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to create room while unauthenticated.");
                    break;
                }

                // leave current room
                if (userState.roomId) {
                    let userRoom = rooms.get(roomId);
                    userRoom.delete(userState.id);
                    userState.roomId = null;

                    if (userRoom.size == 0) {
                        // room is destroyed when there are no people in it
                        rooms.delete(roomId);
                    }
                }

                userState.roomId = ++roomCount;
                rooms.set(userState.roomId, [userState.id]);

                ws.send(JSON.stringify({
                    "type": responseTypes.ROOM,
                    "payload": rooms.get(userState.roomId)
                }));

                sessions.forEach((state, wsConn) => {
                    wsConn.send(JSON.stringify({
                        "type": responseTypes.ROOMS,
                        "payload": JSON.stringify(rooms.keys())
                    }));
                });
                break;
            case messageTypes.JOIN_ROOM:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to create room while unauthenticated.");
                    break;
                }

                if(!rooms.has(message.payload)) {
                    ws.send(JSON.stringify({
                        "type": responseTypes.ERROR,
                        "payload": "Cannot join a room that doesn't exist."
                    }));
                }

                // leave current room
                if (userState.roomId) {
                    let userRoom = rooms.get(roomId);
                    userRoom.delete(userState.id);
                    userState.roomId = null;

                    if (userRoom.size == 0) {
                        // room is destroyed when there are no people in it
                        rooms.delete(roomId);
                    }
                }

                userState.roomId = message.payload;

                ws.send(JSON.stringify({
                    "type": responseTypes.ROOM,
                    "payload": rooms.get(userState.roomId)
                }));
                
            default:
                ws.close(1008, "Received payload of invalid type: " + message.type);
        }
    });

    ws.on('close', () => {
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
            let onlinePeople = [];
            sessions.forEach(userState => {
                if (userState.name) {
                    onlinePeople.push(userState.name);
                }
            });
            ws.send(JSON.stringify({
                "type": responseTypes.ONLINE_PEOPLE,
                "payload": onlinePeople
            }));
        }
    });
}, 10000);

lobbyServer.on('close', () => {
    clearInterval(interval);
});

async function getId(username) {
    const query = `SELECT id
    FROM user
    WHERE username = ?;`;
    const [results, fields] = await connectionPool.query(query, [username]);
    if (!results.length) {
        return false;
    }
    return results[0].id;
}

async function getName(userId) {
    const query = `SELECT username
    FROM user
    WHERE id = ?;`;
    const [results, fields] = await connectionPool.query(query, [userId]);
    if (!results.length) {
        return false;
    }
    return results[0].username;
}

async function addFriendRequest(userId, friendName) {
    const friendId = await getId(friendName);
    const username = await getName(userId);
    if ((await getFriendRequests(friendId)).includes(username) || !friendId || friendId == userId) {
        return false;
    }
    const query = `INSERT INTO friend_request (user_id, friend_id)
    VALUES (?,?);`
    const [results, fields] = await connectionPool.query(query, [userId, friendId]);

    await Promise.all([
        removeFoe(userId, friendName),
        removeFoe(friendId, await getName(userId))
    ]);
    return true;

}

async function removeFriendRequest(userId, friendId) {
    const query = `DELETE FROM friend_request
    WHERE user_id = ? AND friend_id = ?`;
    const [results, fields] = await connectionPool.query(query, [userId, friendId]);
    return true;
}

async function getFriendRequests(userId) {
    const query = `SELECT username
    FROM friend_request
    INNER JOIN user
        ON friend_request.user_id = user.id
    WHERE friend_request.friend_id = ?;`;
    const [results, fields] = await connectionPool.query(query, [userId]);
    let friendRequests = [];
    results.forEach(row => {
        friendRequests.push(row.username);
    });
    return friendRequests;
}

async function getFriends(userId) {
    const query = `SELECT username
    FROM user
    WHERE id IN (
        (SELECT first_user_id FROM friendship WHERE second_user_id = ?)
        UNION
        (SELECT second_user_id FROM friendship WHERE first_user_id = ?)
    );`;
    const [results, fields] = await connectionPool.query(query, [userId, userId]);
    let friends = [];
    results.forEach(row => {
        friends.push(row.username);
    });
    return friends;
}

async function getFoes(userId) {
    const query = `SELECT username
    FROM user
    INNER JOIN foeship
        ON foeship.foe_id = user.id
    WHERE foeship.user_id = ?`;
    const [results, fields] = await connectionPool.query(query, [userId]);
    let foes = [];
    results.forEach(row => {
        foes.push(row.username);
    });
    return foes;
}

async function removeFriend(userId, friendName) {
    const friendId = await getId(friendName);
    const query = `DELETE FROM friendship
    WHERE 
        (friendship.first_user_id = ? AND second_user_id = ?)
        OR
        (friendship.second_user_id = ? AND first_user_id = ?)`;
    const [results, fields] = await connectionPool.query(query, [userId, friendId, userId, friendId]);
    return true;
}

async function removeFoe(userId, foeName) {
    const query = `DELETE foeship 
    FROM foeship
    INNER JOIN user
        ON foeship.foe_id = user.id
    WHERE foeship.user_id = ? AND user.username = ?`;
    const [results, fields] = await connectionPool.query(query, [userId, foeName]);
    return true;
}

async function addFriend(userId, friendName) {
    const friendId = await getId(friendName);
    if ((await getFriends(userId)).includes(friendName) || !friendId || friendId == userId) {
        return false;
    }
    const query = `INSERT INTO friendship (first_user_id, second_user_id)
    VALUES (?,?);`
    const parameters = [userId, friendId].sort(); // smallest ID as first_user
    const [results, fields] = await connectionPool.query(query, parameters);

    await Promise.all([
        removeFoe(userId, friendName),
        removeFoe(friendId, await getName(userId)),
        removeFriendRequest(userId, friendId),
        removeFriendRequest(friendId, userId)
    ]);
    return true;
}

async function addFoe(userId, foeName) {
    const foeId = await getId(foeName);
    if ((await getFoes(userId)).includes(foeName) || !foeId || foeId == userId) {
        return false;
    }
    const query = `INSERT INTO foeship (user_id, foe_id)
    VALUES (?,?);`
    const [results, fields] = await connectionPool.query(query, [userId, foeId]);

    await Promise.all([
        removeFriend(userId, foeName),
        removeFriendRequest(userId, foeName),
        removeFriendRequest(foeId, await getName(userId))
    ]);
    return true;
}