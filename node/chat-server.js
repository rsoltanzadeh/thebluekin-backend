console.log("Running chat-server.js.");

const ws = require('ws');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const mysql = require('mysql2/promise');

const messageTypes = {
    AUTHENTICATOR: 0,
    MESSAGE: 1,
    ADD_FRIEND: 2,
    ADD_FOE: 3,
    REMOVE_FRIEND: 4,
    REMOVE_FOE: 5,
    DISMISS_FRIEND_REQUEST: 6
};

const responseTypes = {
    AUTHENTICATED: 0,
    MESSAGE: 1,
    FRIENDS: 2,
    FOES: 3,
    ONLINE_PEOPLE: 4,
    ERROR: 5,
    FRIEND_REQUESTS: 6
};
const chatServer = new ws.WebSocketServer({
    port: 3001,
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

chatServer.on('upgrade', res => {

})
chatServer.on('connection', (ws, req) => {
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
                    if (payload.aud != "chat") {
                        ws.close(1008, `Wrong JWT audience: ${payload.aud}. Expected "chat".`);
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
                userState.friends = await getFriends(userState.id);
                userState.foes = await getFoes(userState.id);
                userState.friendRequests = await getFriendRequests(userState.id);
                sessions.forEach((state, wsConn) => {
                    if (state.name == userState.name && ws != wsConn) {
                        wsConn.close(1008, "Another login detected.");
                    }
                });
                ws.send(JSON.stringify({
                    "type": responseTypes.AUTHENTICATED
                }));
                ws.send(JSON.stringify({
                    "type": responseTypes.FRIENDS,
                    "payload": userState.friends
                }));
                ws.send(JSON.stringify({
                    "type": responseTypes.FOES,
                    "payload": userState.foes
                }));
                ws.send(JSON.stringify({
                    "type": responseTypes.FRIEND_REQUESTS,
                    "payload": userState.friendRequests
                }));
                break;
            case messageTypes.MESSAGE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to send message while unauthenticated.");
                    break;
                }
                const recipient = message.payload.recipient;
                const text = message.payload.text;
                sessions.forEach((state, wsConnection) => {
                    if (state.name == recipient) {
                        wsConnection.send(JSON.stringify({
                            "type": responseTypes.MESSAGE,
                            "payload": {
                                "text": text,
                                "author": userState.name,
                                "windowName": userState.name
                            }
                        }));
                        ws.send(JSON.stringify({
                            "type": responseTypes.MESSAGE,
                            "payload": {
                                "text": text,
                                "author": "",
                                "windowName": recipient
                            }
                        }));
                    }
                });
                break;
            case messageTypes.ADD_FRIEND:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to add friend while unauthenticated.");
                    break;
                }

                if (userState.friends.includes(message.payload)) {
                    ws.send(JSON.stringify({
                        "type": responseTypes.ERROR,
                        "payload": "Cannot request friendship of current friend: " + message.payload
                    }));
                    break;
                }

                if (userState.friendRequests.includes(message.payload)) { // other party also wants to be friends
                    if (await addFriend(userState.id, message.payload)) {
                        userState.friends = await getFriends(userState.id);
                        userState.friendRequests = await getFriendRequests(userState.id);

                        ws.send(JSON.stringify({
                            "type": responseTypes.FRIENDS,
                            "payload": userState.friends
                        }));
                        ws.send(JSON.stringify({
                            "type": responseTypes.FRIEND_REQUESTS,
                            "payload": userState.friendRequests
                        }));
                        ws.send(JSON.stringify({
                            "type": responseTypes.FOES,
                            "payload": userState.foes
                        }));
                    } else {
                        ws.send(JSON.stringify({
                            "type": responseTypes.ERROR,
                            "payload": "Failed to add friend: " + message.payload
                        }));
                    }
                    sessions.forEach(async (state, wsConnection) => {
                        if (state.name == message.payload) {
                            state.friends = await getFriends(state.id);
                            wsConnection.send(JSON.stringify({
                                "type": responseTypes.FRIENDS,
                                "payload": state.friends
                            }));
                        }
                    });
                } else { // other party has not yet expressed interest in friendship
                    if (await addFriendRequest(userState.id, message.payload)) {
                        sessions.forEach(async (state, wsConnection) => {
                            if (state.name == message.payload) {
                                state.friendRequests = await getFriendRequests(state.id);
                                state.friends = await getFriends(state.id);
                                wsConnection.send(JSON.stringify({
                                    "type": responseTypes.FRIEND_REQUESTS,
                                    "payload": state.friendRequests
                                }));
                            }
                        });
                    } else {
                        ws.send(JSON.stringify({
                            "type": responseTypes.ERROR,
                            "payload": "Failed to add friend request: " + message.payload
                        }));
                    }
                }
                break;
            case messageTypes.ADD_FOE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to add foe while unauthenticated.");
                    break;
                }
                if (await addFoe(userState.id, message.payload)) {
                    userState.foes = await getFoes(userState.id);
                    ws.send(JSON.stringify({
                        "type": responseTypes.FOES,
                        "payload": userState.foes
                    }));
                    ws.send(JSON.stringify({
                        "type": responseTypes.FRIENDS,
                        "payload": userState.friends
                    }));
                } else {
                    ws.send(JSON.stringify({
                        "type": responseTypes.ERROR,
                        "payload": "Failed to add foe: " + message.payload
                    }));
                }
                break;
            case messageTypes.REMOVE_FRIEND:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to remove friend while unauthenticated.");
                    break;
                }
                if (await removeFriend(userState.id, message.payload)) {
                    userState.friends = await getFriends(userState.id);
                    ws.send(JSON.stringify({
                        "type": responseTypes.FRIENDS,
                        "payload": userState.friends
                    }));
                } else {
                    ws.send(JSON.stringify({
                        "type": responseTypes.ERROR,
                        "payload": "Failed to remove friend: " + message.payload
                    }));
                }
                break;
            case messageTypes.REMOVE_FOE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to remove foe while unauthenticated.");
                    break;
                }
                if (await removeFoe(userState.id, message.payload)) {
                    userState.foes = await getFoes(userState.id);
                    ws.send(JSON.stringify({
                        "type": responseTypes.FOES,
                        "payload": userState.foes
                    }));
                } else {
                    ws.send(JSON.stringify({
                        "type": responseTypes.ERROR,
                        "payload": "Failed to remove foe: " + message.payload
                    }));
                }
                break;
            case messageTypes.DISMISS_FRIEND_REQUEST:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to dismiss friend request while unauthenticated.");
                    break;
                }
                ws.send(JSON.stringify({
                    "type": responseTypes.FRIEND_REQUESTS,
                    "payload": userState.friendRequests
                }));

                break;
            default:
                ws.close(1008, "Received payload of invalid type: " + message.type);
        }
    });

    ws.on('close', () => {
        sessions.delete(ws);
    });
})

const interval = setInterval(() => {
    chatServer.clients.forEach(ws => {
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

chatServer.on('close', () => {
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