const express = require('express');
const session = require('express-session');
const csrf = require('csurf');
const fs = require('fs');
const mysql = require('mysql');
const phpPassword = require('node-php-password');
const validator = require('email-validator');
const { exit } = require('process');
const jwt = require('jsonwebtoken');
const app = express();
const csrfProtection = csrf();

const privateKeyRS256 = fs.readFileSync('../jwtRS256.key');
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

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
    cookie: {
        secure: true
    },
    secret: 'test secret',
    proxy: true,
    resave: false,
    saveUninitialized: false
}));

app.get('/api/get-token', csrfProtection, (req, res) => {
    res.send(req.csrfToken());
});

app.get('/api/get-chat-jwt', csrfProtection, (req, res) => {
    if (!req.session.username) {
        res.send("Unauthorized.");
        return;
    }

    const token = jwt.sign(
        {
            "sub": req.session.id,
            "username": req.session.username,
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

app.post('/api/register', (req, res) => {
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

    connection.query('SELECT id FROM user WHERE username = ?', [reqUsername], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }

        if (results.length > 0) {
            res.send('Username already exists.');
            return;
        }
    });
    connection.query('SELECT id FROM user WHERE email = ?', [reqEmail], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }

        if (results.length > 0) {
            res.send('E-mail already exists.');
            return;
        }
    });

    let newPassword = phpPassword.hash(sensitiveData.dbPepper + reqPassword);
    connection.query('INSERT INTO user (username, email, password) VALUES (?,?,?)', [reqUsername, reqEmail, newPassword], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }
        res.send("success");
    });
});

app.post('/api/login', csrfProtection, (req, res) => {
    const reqUsername = req.body.username;
    const reqPassword = req.body.password;
    if (!reqUsername || !reqPassword) {
        res.send("Received data in invalid format: " + JSON.stringify(req.body));
        return;
    }

    connection.query('SELECT id, password FROM user WHERE username = ?', [reqUsername], function queryCallback(error, results, fields) {
        if (error) {
            throw error;
        }
        if (results.length > 1) {
            throw `Duplicate entry for username ${reqUsername}.`;
        } else if (results.length == 0) {
            connection.query('INSERT INTO login (username, success) VALUES (?,?)', [reqUsername, false], function queryCallback(error2, results2, fields2) {
                console.log(`Login failed for username ${reqUsername}.`);
                if (error2) {
                    throw error2;
                }
            });
        } else {
            let passwordHash = results[0].password;
            if (phpPassword.verify(sensitiveData.dbPepper + reqPassword, passwordHash)) {
                connection.query('INSERT INTO login (username, success) VALUES (?,?)', [reqUsername, true], function queryCallback(error2, results2, fields2) {
                    console.log(`Login succeeded for user ${reqUsername}.`);
                    if (error2) {
                        throw error2;
                    }

                    // prevent session fixation attack
                    req.session.regenerate(err => {
                        if (err) {
                            throw err;
                        }
                    })
                    req.session.username = reqUsername;
                    req.session.userid = results[0].id;
                    res.send("success");
                })
            } else {
                connection.query('INSERT INTO login (username, success) VALUES (?,?)', [reqUsername, false], function queryCallback(error, results, fields) {
                    console.log(`Login failed for username ${reqUsername}.`);
                    if (error) {
                        throw error;
                    }
                });
            }
        }
    });
});

app.listen(4001);