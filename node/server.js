console.log("Running server.js");

const express = require('express');
const session = require('express-session');
const csrf = require('csurf');
const fs = require('fs');
const mysql = require('mysql2/promise');
const phpPassword = require('node-php-password');
const validator = require('email-validator');
const { exit } = require('process');
const jwt = require('jsonwebtoken');
const { MemoryStore } = require('express-session');
const app = express();
const csrfProtection = csrf();

const paths = JSON.parse(fs.readFileSync('../config/paths.json'));
const privateKeyRS256 = fs.readFileSync(paths.privateKeyRS256);
const sensitiveData = JSON.parse(fs.readFileSync(paths.sensitiveData));
const connectionPool = mysql.createPool({
    socketPath: paths.mySQLSocketPath,
    host: 'localhost',
    user: sensitiveData.dbUsername,
    password: sensitiveData.dbPassword,
    database: 'mafia',
    charset: 'utf8mb4'
});

app.set('trust proxy', 1);
app.use(express.json());

const myStore = new MemoryStore();

const mySession = session({
    cookie: {
        secure: false //change to true in production
    },
    secret: 'test secret',
    proxy: true,
    resave: false,
    saveUninitialized: false,
    store: myStore
});

app.use(mySession);

app.get('/api/get-token', csrfProtection, (req, res) => {
    res.send(req.csrfToken());
});

app.get('/api/get-lobby-jwt', csrfProtection, (req, res) => {
    if (!req.session.username) {
        res.send("Unauthorized.");
        return;
    }

    const token = jwt.sign(
        {
            "sub": req.session.username,
            "aud": "lobby",
            "exp": Date.now() / 1000 + 30, // expires in 30 seconds
            "iat": Date.now() / 1000
        },
        privateKeyRS256,
        {
            algorithm: "RS256"
        }
    );
    res.send(token);
});

app.get('/api/get-chat-jwt', csrfProtection, (req, res) => {
    if (!req.session.username) {
        res.send("Unauthorized.");
        return;
    }

    const token = jwt.sign(
        {
            "sub": req.session.username,
            "aud": "chat",
            "exp": Date.now() / 1000 + 30, // expires in 30 seconds
            "iat": Date.now() / 1000
        },
        privateKeyRS256,
        {
            algorithm: "RS256"
        }
    );
    res.send(token);
});

app.get('/api/get-game-jwt', csrfProtection, (req, res) => {
    if (!req.session.username) {
        res.send("Unauthorized.");
        return;
    }

    const token = jwt.sign(
        {
            "sub": req.session.username,
            "aud": "game",
            "exp": Date.now() / 1000 + 30, // expires in 30 seconds
            "iat": Date.now() / 1000
        },
        privateKeyRS256,
        {
            algorithm: "RS256"
        }
    );
    res.send(token);
});

app.post('/api/register', async (req, res) => {
    const reqUsername = req.body.username;
    const reqPassword = req.body.password;
    const reqEmail = req.body.email;
    if (!reqUsername || !reqPassword || !reqEmail) {
        res.send("Received data in invalid format: " + JSON.stringify(req.body));
        return;
    }

    if (reqUsername.length < 1) {
        res.send('Username is too short.');
        return;
    } else if (reqPassword.length < 1) {
        res.send('Password is too short.');
        return;
    } else if (reqUsername.length > 20) {
        res.send('Username is too long. (Maximum 20 characters)');
        return;
    } else if (reqPassword.length > 1024) {
        res.send('Password is too long. (Maximum 1024 characters)');
        return;
    } else if (reqEmail.length > 255) {
        res.send('Email address is too long. (Maximum 255 characters)');
        return;
    } else if (!validator.validate(reqEmail)) {
        res.send('E-mail address is invalid.');
        return;
    }

    [results, fields] = await connectionPool.query('SELECT id FROM user WHERE username = ?', [reqUsername]);
    if (results.length > 0) {
        res.send('Username already exists.');
        return;
    }
    [results, fields] = await connectionPool.query('SELECT id FROM user WHERE email = ?', [reqEmail]);
    if (results.length > 0) {
        res.send('E-mail already exists.');
        return;
    }

    let newPassword = phpPassword.hash(sensitiveData.dbPepper + reqPassword);
    [results, fields] = await connectionPool.query('INSERT INTO user (username, email, password) VALUES (?,?,?)', [reqUsername, reqEmail, newPassword]);
    req.session.cookie.username = reqUsername;
    res.send("success");
});

app.get('/api/check-auth', (req, res) => {
    res.send(req.session.username ? true : false);
});

app.get('/api/logout', csrfProtection, (req, res) => {
    req.session.destroy();
    res.send('success');
});

app.post('/api/login', csrfProtection, async (req, res) => {
    const reqUsername = req.body.username;
    const reqPassword = req.body.password;
    if (!reqUsername || !reqPassword) {
        res.send("Received data in invalid format: " + JSON.stringify(req.body));
        return;
    }

    [results, fields] = await connectionPool.query('SELECT id, password FROM user WHERE username = ?', [reqUsername]);
    if (results.length > 1) {
        throw `Duplicate entry for username ${reqUsername}.`;
    } else if (results.length == 0) {
        [results2, fields2] = await connectionPool.query('INSERT INTO login (username, success) VALUES (?,?)', [reqUsername, false]);
        console.log(`Login failed for username ${reqUsername}.`);
    } else {
        let passwordHash = results[0].password;
        if (phpPassword.verify(sensitiveData.dbPepper + reqPassword, passwordHash)) {
            [results2, fields2] = await connectionPool.query('INSERT INTO login (username, success) VALUES (?,?)', [reqUsername, true]);
            console.log(`Login succeeded for user ${reqUsername}.`);

            // prevent session fixation attack
            req.session.regenerate(err => {
                if (err) {
                    throw err;
                }
            })

            req.session.username = reqUsername;
            req.session.userid = results[0].id;
            res.send("success");
        } else {
            [results, fields] = await connectionPool.query('INSERT INTO login (username, success) VALUES (?,?)', [reqUsername, false]);
            console.log(`Login failed for username ${reqUsername}.`);
        }
    }
});

app.listen(4001);