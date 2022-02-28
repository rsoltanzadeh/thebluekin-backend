const express = require('express');
const session = require('express-session');
const csrf = require('csurf');
const fs = require('fs');
const mysql = require('mysql');
const phpPassword = require('node-php-password');
const validator = require('email-validator');
const app = express();
const csrfProtection = csrf();

const sensitiveData = JSON.parse(fs.readFileSync('../sensitive_data.json'));
const connection = mysql.createConnection({
    host: 'localhost',
    user: sensitiveData.dbUsername,
    password: sensitiveData.dbPassword,
    database: 'mafia'
});

connection.connect(err => {
    if(err) {
        console.log("Connection failed: " + err);
    } else {
        console.log("Connection succeeded!");
    }
});

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
    cookie: {
        secure: true
    },
    secret: 'test secret',
    proxy: true
}));

app.get('/api/get-token', csrfProtection, (req, res) => {
    res.send(req.csrfToken());
});

app.post('/api/register', (req, res) => {
    let reqUsername, reqPassword, reqEmail;
    try {
        reqUsername = req.body.username;
        reqPassword = req.body.password;
        reqEmail = req.body.email;
    } catch (e) {
        console.log(e);
        res.send("Received data in invalid format.");
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

    connection.query('SELECT id FROM user WHERE username = ?', [reqUsername], (error, results, fields) => {
        if (error) {
            throw error;
        }

        if (results.length > 0) {
            res.send('Username already exists.');
            return;
        }
    });
    connection.query('SELECT id FROM user WHERE email = ?', [reqEmail], (error, results, fields) => {
        if (error) {
            throw error;
        }

        if (results.length > 0) {
            res.send('E-mail already exists.');
            return;
        }
    });

    newPasword = phpPassword.hash(sensitiveData.dbPepper + reqPassword);
    connection.query('INSERT INTO user (username, email, password) VALUES (?,?,?)', [reqUsername, reqEmail, newPassword], (error, results, fields) => {
        if (error) {
            throw error;
        }
        res.send("success");
    });
});

app.post('/api/login', csrfProtection, (req, res) => {
    let reqUsername, reqPassword;
    try {
        reqUsername = req.body.username;
        reqPassword = req.body.password;
    } catch (e) {
        console.log(e);
        res.send("Received data in invalid format.");
        return;
    }
    connection.query('SELECT username, password FROM user WHERE username = ?', [reqUsername], (error, results, fields) => {
        if (error) {
            throw error;
        }
        if (results.length > 1) {
            throw `Duplicate entry for username ${reqUsername}.`;
        } else if (results.length == 0) {
            connection.query('INSERT INTO login (username, success) VALUES (?,?)', [reqUsername, false], (error, results, fields) => {
                if (error) {
                    throw error;
                }
            });
        } else {
            if (phpPassword.verify(sensitiveData.dbPepper + reqPassword, password)) {
                connection.query('INSERT INTO login (username, success) VALUES (?,?)', [reqUsername, true], (error, results, fields) => {
                    if (error) {
                        throw error;
                    }

                    // prevent session fixation attack
                    req.session.regenerate(err => {
                        if (err) {
                            throw err;
                        }
                    })

                    res.send("success");
                })
            } else {
                connection.query('INSERT INTO login (username, success) VALUES (?,?)', [reqUsername, false], (error, results, fields) => {
                    if (error) {
                        throw error;
                    }
                })
            }
        }
    });
});

app.listen(4001);