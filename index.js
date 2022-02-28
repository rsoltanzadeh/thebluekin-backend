const ws = require('ws');

const chatServer = new ws.WebSocketServer({ 
    port:3001,
    clientTracking: true
 });

chatServer.on('upgrade', res => {

})
chatServer.on('connection', (ws, req) => {
    console.log(req.headers);
    ws.on('message', data => {
        console.log('Received: %s', data);
    });

    ws.send('Connection opened.');
})