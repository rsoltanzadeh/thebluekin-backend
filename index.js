const url = require('url'); 
const fs = require('fs');
const https = require('https');
const history = require('connect-history-api-fallback');
const express = require('express');
const redirectToHTTPS = require('express-http-to-https');
const ws = require('ws');

const app = express();
app.use(redirectToHTTPS([/localhost:(\d{4})/], [], 301));
app.use(express.static('/var/www/thebluekin.com/html'));
app.use(history());

const sensitiveData = JSON.parse(fs.readFileSync('../sensitive_data.json')); 

let options = {
    key: sensitiveData.keyPath,
    cert: sensitiveData.certPath
};

const chatServer = new ws.WebSocketServer({ noServer: true });
chatServer.on('connection', ws => {
    ws.on('message', data => {
        console.log('Received: %s', data);
    });

    ws.send('Connection opened.');
})

const server = https.createServer(options, app);
server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url);
    if(pathname === '/chat') {
        chatServer.handleUpgrade(request, socket, head, ws => {
            chatServer.emit('connection', ws, request);
        });
    }
});

server.listen(8443);