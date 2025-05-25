const express = require('express');
const { WebSocketServer } = require('ws');
const { createClient } = require('redis');

const app = express();
const PORT = 8080;

// Redis setup
const redis = createClient({ url: 'redis://192.168.122.230:6379' });
redis.connect();

const server = app.listen(PORT, () => {
    console.log(`[INFO] Server started on port ${PORT}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
    const [, gameId, color] = req.url.split('/');
    const streamKey = `game:${gameId}`;
    ws.gameId = gameId; // Store gameId in the WebSocket object for later reference

    console.log(`[INFO] New WebSocket connection: gameId=${gameId}, color=${color}`);

    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg);
            console.log(`[INFO] Received message: ${JSON.stringify(data)} from gameId=${gameId}`);

            if (data.type === 'move') {
                const id = await redis.xAdd(streamKey, '*', {
                    type: 'move',
                    move: JSON.stringify(data.move),
                });
                console.log(`[INFO] Added move to stream ${streamKey} with ID ${id}`);

                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        client.send(JSON.stringify({
                            type: 'move',
                            move: data.move,
                            streamId: id,
                        }));
                    }
                });
            }

            if (data.type === 'undo') {
                const id = await redis.xAdd(streamKey, '*', { type: 'undo' });
                console.log(`[INFO] Executed undo on stream ${streamKey} with ID ${id}`);

                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        client.send(JSON.stringify({
                            type: 'undo',
                            streamId: id,
                        }));
                    }
                });
            }

            if (data.type === 'reset') {
                const id = await redis.xAdd(streamKey, '*', { type: 'reset' });
                console.log(`[INFO] Executed reset on stream ${streamKey} with ID ${id}`);

                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === 1 && client.gameId === gameId) {
                        console.log(`[INFO] Resetting game for client gameId=${client.gameId}`);
                        client.send(JSON.stringify({
                            type: 'reset',
                            streamId: id,
                        }));
                    }
                });
            }

            if (data.type === 'resync') {
                console.log(`[INFO] Resync requested for gameId=${gameId}, lastId=${data.lastId}`);
                const lastSeenId = data.lastId || '0-0';
                const entries = await redis.xRead(
                    [{ key: streamKey, id: lastSeenId }],
                    { COUNT: 20 }
                );

                if (entries) {
                    console.log(`[INFO] Found ${entries[0].messages.length} entries for resync`);
                    entries[0].messages.forEach(({ name, message }) => {
                        if (message.type === 'move') {
                            ws.send(JSON.stringify({
                                streamId: name,
                                ...Object.fromEntries(
                                    Object.entries(message).map(([k, v]) => [k, v.toString()])
                                ),
                                move: JSON.parse(message.move)
                            }));
                        } else if (message.type === 'undo') {
                            ws.send(JSON.stringify({
                                streamId: name,
                                type: 'undo'
                            }));
                        } else {
                            console.log(`[INFO] Resetting game for client gameId=${ws.gameId}`);
                            ws.send(JSON.stringify({
                                streamId: name,
                                type: 'reset'
                            }));
                        }
                    });
                } else {
                    console.log(`[INFO] No entries found for resync on stream ${streamKey}`);
                }
            }
        } catch (error) {
            console.error(`[ERROR] Error processing message: ${error.message}`, error);
        }
    });

    ws.on('close', () => {
        console.log(`[INFO] WebSocket connection closed for gameId=${gameId}`);
    });

    ws.on('error', (error) => {
        console.error(`[ERROR] WebSocket error for gameId=${gameId}: ${error.message}`, error);
    });
});
