const ws = require('ws');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const mysql = require('mysql');
const session = require('express-session');

const messageTypes = {
    AUTHENTICATOR: 0,
    MESSAGE: 1,
    ADD_FRIEND: 2,
    ADD_FOE: 3,
    REMOVE_FRIEND: 4,
    REMOVE_FOE: 5
};

const responseTypes = {
    AUTHENTICATED: 0,
    MESSAGE: 1,
    FRIENDS: 2,
    FOES: 3,
    ONLINE_PEOPLE: 4,
    ERROR: 5
};
const chatServer = new ws.WebSocketServer({
    port: 3001,
    clientTracking: true
});

const publicKeyRS256 = fs.readFileSync('../jwtRS256.key.pub');
const sensitiveData = JSON.parse(fs.readFileSync('../sensitive_data.json'));

const connection = mysql.createConnection({
    socketPath: '/var/lib/mysql/mysql.sock',
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

function heartbeat() {
    this.isAlive = true;
}

const sessions = new Map();

chatServer.on('upgrade', res => {

})
chatServer.on('connection', (ws, req) => {
    console.log(req.headers);

    ws.isAlive = true;
    ws.on('pong', heartbeat);

    sessions.set(ws, { "authenticated": false })
    ws.on('message', data => {
        console.log('Received: %s', data);
        let userState = sessions.get(ws);
        let message = JSON.parse(data);
        switch (message.type) {
            case messageTypes.AUTHENTICATOR:
                try {
                    const payload = jwt.verify(message.payload, publicKeyRS256);
                    userState.authenticated = true;
                    userState.id = payload.sub;
                    userState.name = payload.username;
                    userState.friends = getFriends(userState.id);
                    userState.foes = getFoes(userState.id);
                    ws.send(JSON.stringify({
                        "type": responseTypes.FRIENDS,
                        "payload": userState.friends
                    }));
                    ws.send(JSON.stringify({
                        "type": responseTypes.FOES,
                        "payload": userState.foes
                    }));
                } catch (err) {
                    console.log(err);
                    console.log(message);
                }
                break;
            case messageTypes.MESSAGE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to send message while unauthenticated.");
                } else {
                    const recipient = message.payload.recipient;
                    const text = message.payload.text;
                    sessions.forEach(state => {
                        if (state.name == recipient) {
                            ws.send(JSON.stringify({
                                "type": responseTypes.MESSAGE,
                                "payload": text
                            }));
                        }
                    });
                }
                break;
            case messageTypes.ADD_FRIEND:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to add friend while unauthenticated.");
                } else {
                    let success = addFriend(userState.id, message.payload);
                    if (success) {
                        userState.friends = getFriends(userState.id);
                        ws.send(JSON.stringify({
                            "type": responseTypes.FRIENDS,
                            "payload": userState.friends
                        }));
                    } else {
                        ws.send(JSON.strinfigy({
                            "type": responseTypes.ERROR,
                            "payload": "Failed to add friend: " + message.payload
                        }));
                    }
                }
                break;
            case messageTypes.ADD_FOE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to add foe while unauthenticated.");
                } else {
                    let success = addFoe(userState.id, message.payload);
                    if (success) {
                        userState.foes = getFoes(userState.id);
                        ws.send(JSON.stringify({
                            "type": responseTypes.FOES,
                            "payload": userState.foes
                        }));
                    } else {
                        ws.send(JSON.strinfigy({
                            "type": responseTypes.ERROR,
                            "payload": "Failed to add foe: " + message.payload
                        }));
                    }
                }
                break;
            case messageTypes.REMOVE_FRIEND:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to remove friend while unauthenticated.");
                } else {
                    let success = removeFriend(userState.id, message.payload);
                    if (success) {
                        userState.friends = getFriends(userState.id);
                        ws.send(JSON.stringify({
                            "type": responseTypes.FRIENDS,
                            "payload": userState.friends
                        }));
                    } else {
                        ws.send(JSON.strinfigy({
                            "type": responseTypes.ERROR,
                            "payload": "Failed to remove friend: " + message.payload
                        }));
                    }
                }
                break;
            case messageTypes.REMOVE_FOE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to remove foe while unauthenticated.");
                } else {
                    let success = removeFoe(userState.id, message.payload);
                    if (success) {
                        userState.foes = getFoes(userState.id);
                        ws.send(JSON.stringify({
                            "type": responseTypes.FOES,
                            "payload": userState.foes
                        }));
                    } else {
                        ws.send(JSON.strinfigy({
                            "type": responseTypes.ERROR,
                            "payload": "Failed to remove foe: " + message.payload
                        }));
                    }
                }
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
            ws.terminate();
        } else {
            ws.isAlive = false;
            ws.ping();
            let onlinePeople = [];
            sessions.forEach(userState => {
                onlinePeople.push(userState.name);
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

function getFriends(userId) {
    const query = `SELECT username
    FROM user
    INNER JOIN friendship
        ON friendship.friend_id = user.id
    WHERE friendship.user_id = ?`;
    connection.query(query, [userId], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }
        let friends = [];
        results.forEach(row => {
            friends.push(row.username);
        });
        return friends;
    });
}

function getFoes(userId) {
    const query = `SELECT username
    FROM user
    INNER JOIN foeship
        ON foeship.foe_id = user.id
    WHERE foeship.user_id = ?`;
    connection.query(query, [userId], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }
        let foes = [];
        results.forEach(row => {
            foes.push(row.username);
        });
        return foes;
    });
}

function removeFriend(userId, friendName) {
    const query = `DELETE friendship 
    FROM friendship
    INNER JOIN user
        ON friendship.friend_id = user.id
    WHERE friendship.user_id = ? AND user.username = ?`;
    connection.query(query, [userId, friendName], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }

        return true;
    });

}

function removeFoe(userId, foeName) {
    const query = `DELETE foeship 
    FROM foeship
    INNER JOIN user
        ON foeship.foe_id = user.id
    WHERE foeship.user_id = ? AND user.username = ?`;
    connection.query(query, [userId, foeName], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }

        return true;
    });

}

function addFriend(userId, friendName) {
    const query = `INSERT INTO friendship (user_id, friend_id)
    SELECT ?, id
    FROM user
    WHERE username = ?;`
    connection.query(query, [userId, friendName], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }

        return true;
    });
}

function addFoe(userId, foeName) {
    const query = `INSERT INTO foeship (user_id, foe_id)
    SELECT ?, id
    FROM user
    WHERE username = ?;`
    connection.query(query, [userId, foeName], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }

        return true;
    });
}