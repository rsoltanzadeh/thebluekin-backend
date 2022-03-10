const ws = require('ws');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const session = require('express-session');

const MessageTypes = {
    AUTHENTICATOR: 0,
    MESSAGE: 1,
    ADD_FRIEND: 2,
    ADD_FOE: 3,
    REMOVE_FRIEND: 4,
    REMOVE_FOE: 5
};

const ResponseTypes = {
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
    database: 'mafia'
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
        const userState = sessions.get(ws);
        let message = JSON.parse(data);
        switch (message.type) {
            case MessageTypes.AUTHENTICATOR:
                try {
                    const payload = jwt.verify(message.payload, publicKeyRS256);
                    userState.authenticated = true;
                    userState.name = payload.sub;
                    userState.friends = getFriends(userState.name);
                    userState.foes = getFoes(userState.name);
                    ws.send(JSON.stringify({
                        "type": ResponseTypes.FRIENDS,
                        "payload": userState.friends
                    }));
                    ws.send(JSON.stringify({
                        "type": ResponseTypes.FOES,
                        "payload": userState.foes
                    }));


                } catch (err) {
                    console.log(err);
                }
                break;
            case MessageTypes.MESSAGE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to send message while unauthenticated.");
                } else {
                    ws.send(JSON.stringify({
                        "type": ResponseTypes.MESSAGE,
                        "payload": message.payload
                    }));
                }
                break;
            case MessageTypes.ADD_FRIEND:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to add friend while unauthenticated.");
                } else {
                    let success = addFriend(userState.name, message.payload);
                    if (success) {
                        ws.send(JSON.stringify({
                            "type": ResponseTypes.FRIENDS,
                            "payload": userState.friends
                        }));
                    } else {
                        ws.send(JSON.strinfigy({
                            "type": ResponseTypes.ERROR,
                            "payload": "Failed to add friend: " + message.payload
                        }));
                    }
                }
                break;
            case MessageTypes.ADD_FOE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to add foe while unauthenticated.");
                } else {
                    let success = addFoe(userState.name, message.payload);
                    if (success) {
                        ws.send(JSON.stringify({
                            "type": ResponseTypes.FOES,
                            "payload": userState.foes
                        }));
                    } else {
                        ws.send(JSON.strinfigy({
                            "type": ResponseTypes.ERROR,
                            "payload": "Failed to add foe: " + message.payload
                        }));
                    }
                }
                break;
            case MessageTypes.REMOVE_FRIEND:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to remove friend while unauthenticated.");
                } else {
                    let success = removeFriend(userState.name, message.payload);
                    if (success) {
                        ws.send(JSON.stringify({
                            "type": ResponseTypes.FRIENDS,
                            "payload": userState.friends
                        }));
                    } else {
                        ws.send(JSON.strinfigy({
                            "type": ResponseTypes.ERROR,
                            "payload": "Failed to remove friend: " + message.payload
                        }));
                    }
                }
                break;
            case MessageTypes.REMOVE_FOE:
                if (!userState.authenticated) {
                    ws.close(1008, "Attempt to remove foe while unauthenticated.");
                } else {
                    let success = removeFoe(userState.name, message.payload);
                    if (success) {
                        ws.send(JSON.stringify({
                            "type": ResponseTypes.FOES,
                            "payload": userState.foes
                        }));
                    } else {
                        ws.send(JSON.strinfigy({
                            "type": ResponseTypes.ERROR,
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

    ws.send('Connection opened.');
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
                "type": ResponseTypes.ONLINE_PEOPLE,
                "payload": onlinePeople
            }));
        }
    });
}, 10000);

chatServer.on('close', () => {
    clearInterval(interval);
});

function getFriends(user) {

}

function getFoes(user) {

}

function removeFriend(user, friend) {

}

function removeFoe(user, foe) {

}

function addFriend(user, friend) {

}

function addFoe(user, foe) {

}